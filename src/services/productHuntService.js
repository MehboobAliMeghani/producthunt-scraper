/**
 * productHuntService.js
 *
 * Talks to the official Product Hunt v2 GraphQL API and returns clean,
 * structured post data. This is intentionally the *only* thing this module
 * does — later pipeline stages (email discovery, Sheets export, OpenAI
 * enrichment, GMass sending, etc.) will consume the array returned by
 * getTodaysProducts() and live in their own service modules.
 *
 * PH API docs: https://api.producthunt.com/v2/docs
 */

const {
  PRODUCT_HUNT_API_TOKEN,
  PRODUCT_HUNT_GRAPHQL_URL,
  PRODUCT_HUNT_MAX_PAGES,
  PRODUCT_HUNT_PAGE_DELAY_MS,
} = require('../config/env');

// --- Tuning knobs for retry behavior -------------------------------------
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500; // doubles each retry: 500, 1000, 2000, 4000, 8000
const PAGE_SIZE = 50; // PH caps `first` around 50 per page for posts

// PH documents a 15-minute rate limit window. If a 429 response doesn't
// carry a parseable `reset_in`, assume the full window needs to elapse
// rather than guessing something shorter and immediately re-hitting the
// limit.
const RATE_LIMIT_FALLBACK_RESET_SECONDS = 15 * 60;
// Extra cushion added on top of PH's own reported reset time, so we don't
// resume a split-second before the window actually rolls over.
const RATE_LIMIT_WAIT_BUFFER_SECONDS = 5;

/**
 * Thrown by graphqlRequest when a 429 persists across all of its internal
 * retries. Distinct from a generic Error so getTodaysProducts() can catch
 * it specifically and wait-and-resume rather than aborting the whole run.
 */
class RateLimitExceededError extends Error {
  constructor(message, resetInSeconds) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.resetInSeconds = resetInSeconds;
  }
}

// GraphQL query for a single page of posts, filtered to a date window and
// ordered newest-first. `after` is the pagination cursor from the previous
// page's pageInfo.endCursor (omit/null for the first page).
//
// IMPORTANT: order is NEWEST, not VOTES/RANKING. Those orderings sort by a
// metric that keeps changing while we're mid-pagination (vote counts go up
// in real time), which can shift posts between pages and make the cursor
// connection never settle into hasNextPage: false — this is the likely
// cause of a previous run making 6250+ requests for a single day. NEWEST
// orders by creation time, which is immutable, so cursor pagination over a
// fixed date window is stable and terminates predictably.
//
// `createdAt` is included (not part of the public return shape) purely so
// getTodaysProducts() can verify server-side that postedAfter/postedBefore
// are actually being honored — see the in-range check below.
const POSTS_QUERY = `
  query TodaysPosts($postedAfter: DateTime!, $postedBefore: DateTime!, $first: Int!, $after: String) {
    posts(postedAfter: $postedAfter, postedBefore: $postedBefore, first: $first, after: $after, order: NEWEST) {
      edges {
        node {
          id
          name
          tagline
          description
          url
          website
          votesCount
          createdAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PACIFIC_TIME_ZONE = 'America/Los_Angeles';

/**
 * Returns how far `timeZone`'s local wall-clock time is ahead of UTC, in
 * milliseconds, at the instant `date` represents. Computed dynamically via
 * Intl.DateTimeFormat rather than a hardcoded offset so it's correct across
 * DST transitions (e.g. PDT = UTC-7 vs PST = UTC-8).
 */
function getTimeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    parts[type] = value;
  }
  // Reinterpret the timeZone's local wall-clock reading as if it were UTC;
  // the gap between that and the real UTC instant is the zone's offset.
  const asUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtcMs - date.getTime();
}

/**
 * Returns the UTC instant corresponding to local midnight of `year-month-day`
 * in `timeZone`. DST transitions in the US happen at 2am local time, never
 * at midnight, so using the offset in effect at a UTC-midnight guess is
 * always correct for the actual local midnight of that same calendar date.
 */
function getLocalMidnightUtc(year, month, day, timeZone) {
  const guessUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMs = getTimeZoneOffsetMs(new Date(guessUtcMs), timeZone);
  return new Date(guessUtcMs - offsetMs);
}

/**
 * Returns { year, month, day } (1-indexed month) for the current calendar
 * date in `timeZone`.
 */
function getLocalDateParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    parts[type] = value;
  }
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/**
 * Returns the [start, end) ISO 8601 UTC boundaries for "today" as Product
 * Hunt defines it — midnight-to-midnight Pacific Time, not UTC — used to
 * filter posts via postedAfter / postedBefore.
 */
function getTodayPacificRangeInUtc() {
  const now = new Date();
  const { year, month, day } = getLocalDateParts(now, PACIFIC_TIME_ZONE);

  const startOfDay = getLocalMidnightUtc(year, month, day, PACIFIC_TIME_ZONE);

  // Advance the calendar date by one day (timezone-naive UTC arithmetic is
  // fine here — we only need correct Y/M/D to re-derive PT midnight from,
  // which also handles month/year rollovers for free).
  const nextCalendarDay = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
  const startOfNextDay = getLocalMidnightUtc(
    nextCalendarDay.getUTCFullYear(),
    nextCalendarDay.getUTCMonth() + 1,
    nextCalendarDay.getUTCDate(),
    PACIFIC_TIME_ZONE
  );

  return {
    postedAfter: startOfDay.toISOString(),
    postedBefore: startOfNextDay.toISOString(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pulls Product Hunt's rate limit info off the response headers (PH sends
 * these on every API response) so callers can log/monitor quota usage.
 * Returns nulls for any header that isn't present rather than throwing.
 */
function extractRateLimitInfo(response) {
  const limit = response.headers.get('x-rate-limit-limit');
  const remaining = response.headers.get('x-rate-limit-remaining');
  const reset = response.headers.get('x-rate-limit-reset');
  return {
    limit: limit !== null ? Number(limit) : null,
    remaining: remaining !== null ? Number(remaining) : null,
    resetSeconds: reset !== null ? Number(reset) : null,
  };
}

/**
 * Best-effort extraction of the `reset_in` seconds value from a 429
 * response body — PH documents this as the number of seconds until quota
 * resets. Checks both a top-level `reset_in` and a nested
 * `errors[].extensions.reset_in`, since PH's error shape for this isn't
 * consistently documented. Returns null (never throws) if it can't be
 * found, so callers can fall back to a safe default.
 */
async function extractResetInSeconds(response) {
  try {
    const body = await response.clone().json();
    if (body && typeof body.reset_in === 'number') {
      return body.reset_in;
    }
    if (body && Array.isArray(body.errors)) {
      for (const err of body.errors) {
        if (err && err.extensions && typeof err.extensions.reset_in === 'number') {
          return err.extensions.reset_in;
        }
      }
    }
  } catch (_parseError) {
    // Body wasn't JSON, or didn't have the field — fall through to null.
  }
  return null;
}

/**
 * Executes a single GraphQL request against the PH API with retry handling.
 * Retries on rate limiting (429) and transient server errors (5xx) and on
 * network-level failures (e.g. fetch throwing). Anything else — bad auth,
 * malformed query, etc. — fails immediately with a descriptive error so
 * problems surface loudly instead of hanging or silently returning nothing.
 *
 * Returns { data, rateLimit } so callers can surface quota usage.
 */
async function graphqlRequest(query, variables) {
  if (!PRODUCT_HUNT_API_TOKEN) {
    throw new Error(
      'PRODUCT_HUNT_API_TOKEN is not set. Add it to your .env file — see README for how to generate one.'
    );
  }

  let attempt = 0;

  while (true) {
    attempt += 1;
    let response;

    try {
      response = await fetch(PRODUCT_HUNT_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PRODUCT_HUNT_API_TOKEN}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (networkError) {
      if (attempt > MAX_RETRIES) {
        throw new Error(
          `Product Hunt API request failed after ${MAX_RETRIES} retries (network error): ${networkError.message}`
        );
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    // Rate limiting: retry a few short/transient 429s with backoff (spaced
    // out, never hammered back-to-back), but if it persists past
    // MAX_RETRIES, treat it as a real quota exhaustion rather than a fluke —
    // surface it as a typed error so the caller can wait out PH's actual
    // reset window and resume, instead of us guessing with more backoff.
    if (response.status === 429) {
      if (attempt > MAX_RETRIES) {
        const resetInSeconds = (await extractResetInSeconds(response)) ?? RATE_LIMIT_FALLBACK_RESET_SECONDS;
        throw new RateLimitExceededError(
          `Product Hunt API rate limit exceeded after ${MAX_RETRIES} retries`,
          resetInSeconds
        );
      }
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const delay = retryAfterMs || BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(delay);
      continue;
    }

    // Transient server errors: same bounded exponential backoff, but these
    // are unrelated to quota so a generic failure after MAX_RETRIES is
    // still correct here.
    if (response.status >= 500) {
      if (attempt > MAX_RETRIES) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Product Hunt API request failed after ${MAX_RETRIES} retries (HTTP ${response.status}): ${body}`
        );
      }
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(delay);
      continue;
    }

    // Any other non-2xx status is not transient — fail loudly, no retry.
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Product Hunt API request failed with HTTP ${response.status} ${response.statusText}: ${body}`
      );
    }

    const rateLimit = extractRateLimitInfo(response);
    const payload = await response.json();

    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((e) => e.message).join('; ');
      throw new Error(`Product Hunt API returned GraphQL errors: ${message}`);
    }

    return { data: payload.data, rateLimit };
  }
}

/**
 * Maps a raw PH `Post` GraphQL node to the clean shape the rest of the
 * pipeline consumes.
 */
function mapPostNode(node) {
  return {
    id: node.id,
    name: node.name,
    tagline: node.tagline,
    description: node.description,
    website: node.website,
    productHuntUrl: node.url,
    votesCount: node.votesCount,
  };
}

/**
 * Fetches every Product Hunt post posted "today" — Pacific Time, which is
 * how PH itself defines its daily window — following pagination until PH
 * reports no more pages, and returns a clean array of:
 *   { id, name, tagline, description, website, productHuntUrl, votesCount }
 */
async function getTodaysProducts() {
  const { postedAfter, postedBefore } = getTodayPacificRangeInUtc();
  const postedAfterMs = new Date(postedAfter).getTime();
  const postedBeforeMs = new Date(postedBefore).getTime();

  console.log(
    `[productHuntService] Today's PT window (in UTC): postedAfter=${postedAfter} postedBefore=${postedBefore}`
  );

  const products = [];
  let after = null;
  let hasNextPage = true;
  let page = 0;
  let totalRequests = 0;

  while (hasNextPage) {
    page += 1;

    // Hard safety cap: if a bug (bad cursor, an API quirk, a filter that
    // silently stops being honored, etc.) causes pagination to run away,
    // stop instead of burning the whole rate limit like last time.
    if (page > PRODUCT_HUNT_MAX_PAGES) {
      console.warn(
        `[productHuntService] Safety cap hit: stopped after ${PRODUCT_HUNT_MAX_PAGES} pages ` +
          `(${products.length} products collected so far). This is far more pages than a single ` +
          `day of posts should need — investigate the date filter / ordering / cursor logic ` +
          `before raising PRODUCT_HUNT_MAX_PAGES.`
      );
      break;
    }

    // Retry the *same* page (same cursor) across rate-limit waits — a
    // persistent 429 here means quota is genuinely exhausted, not that this
    // page's request was malformed, so we wait out PH's reported reset
    // window and resume rather than giving up with partial results.
    let data;
    let rateLimit;
    while (true) {
      try {
        ({ data, rateLimit } = await graphqlRequest(POSTS_QUERY, {
          postedAfter,
          postedBefore,
          first: PAGE_SIZE,
          after,
        }));
        break;
      } catch (error) {
        if (!(error instanceof RateLimitExceededError)) {
          throw error;
        }
        const waitSeconds = error.resetInSeconds + RATE_LIMIT_WAIT_BUFFER_SECONDS;
        console.warn(
          `[productHuntService] Rate limit hit on page ${page} — waiting ${waitSeconds}s for quota reset, then resuming.`
        );
        await sleep(waitSeconds * 1000);
      }
    }
    totalRequests += 1;

    const posts = data && data.posts;
    if (!posts) {
      throw new Error('Product Hunt API response was missing the expected "posts" field.');
    }

    console.log(
      `[productHuntService] page ${page} | cursor=${after || '(first page)'} | ` +
        `edges=${posts.edges.length} | hasNextPage=${posts.pageInfo.hasNextPage} | ` +
        `endCursor=${posts.pageInfo.endCursor || '(none)'} | requests so far=${totalRequests} | ` +
        `rate limit remaining=${rateLimit.remaining ?? '?'}/${rateLimit.limit ?? '?'}` +
        (rateLimit.resetSeconds !== null ? ` (resets in ${rateLimit.resetSeconds}s)` : '')
    );

    // Defensive check: with NEWEST ordering, if the feed has walked all the
    // way past the target day (e.g. the server-side date filter isn't being
    // strictly enforced at the boundary), an entire page will consist of
    // posts outside the window. Stop rather than continuing to page through
    // unrelated days.
    const allOutOfRange =
      posts.edges.length > 0 &&
      posts.edges.every((edge) => {
        const createdAtMs = new Date(edge.node.createdAt).getTime();
        return createdAtMs < postedAfterMs || createdAtMs >= postedBeforeMs;
      });
    if (allOutOfRange) {
      console.warn(`[productHuntService] All products on page ${page} outside date window — stopping`);
      break;
    }

    for (const edge of posts.edges) {
      products.push(mapPostNode(edge.node));
    }

    hasNextPage = posts.pageInfo.hasNextPage;
    after = posts.pageInfo.endCursor;

    // Deliberate throttle between pages — PH's quota appears to replenish
    // gradually rather than only at a fixed window boundary, so pacing
    // requests below full speed keeps a multi-page run sustainable instead
    // of cliff-diving into the rate limit.
    if (hasNextPage && PRODUCT_HUNT_PAGE_DELAY_MS > 0) {
      await sleep(PRODUCT_HUNT_PAGE_DELAY_MS);
    }
  }

  return products;
}

module.exports = {
  getTodaysProducts,
};
