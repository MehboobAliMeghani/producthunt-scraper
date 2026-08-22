/**
 * redirectResolverService.js
 *
 * Product Hunt's `website` field is a producthunt.com/r/... tracking
 * redirect, not the product's actual site. This module follows that
 * redirect chain for each product and records the final destination URL,
 * so later pipeline stages (email discovery, etc.) have a real domain to
 * work with.
 *
 * Runs in small batches (not a fully rolling concurrency pool) since a
 * single day's run can be ~800 products and Cloudflare in front of PH's
 * /r/ links appears to flag on request *volume/frequency*, not just
 * headers — a batch of 8 with a short pause between batches mirrors a
 * previously-working implementation's pacing and avoids that threshold.
 */

const DEFAULT_CONCURRENCY = 8;
const BATCH_DELAY_MS = 750; // pause between batches, not between every request
const REQUEST_TIMEOUT_MS = 10_000;
const PROGRESS_LOG_INTERVAL = 50;

// Specifically for 403s: a transient rate-limit-style block may clear up
// once Cloudflare's pressure eases, so retry a couple of times before
// giving up. Other statuses (404, etc.) are not retried — they're not
// going to change on a second try.
const MAX_403_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1000;

// Matches a previously working implementation of this step: an honest,
// self-identifying bot UA plus a plain Accept header — no Referer, no
// Accept-Language, no spoofed browser fingerprint. A spoofed Chrome UA is
// exactly what got every request 403'd; PH's own /r/ redirect links are
// fine with an unauthenticated, clearly-labeled bot request.
const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; PHResolver/1.0; +https://producthunt.com)',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Logs the full response status + all response headers for a non-2xx final
 * response, so a blocked/bot-detected request (e.g. Cloudflare returning
 * 403 with `cf-ray` / `server: cloudflare` headers) can be diagnosed from
 * the logs rather than just seeing an opaque "HTTP 403".
 */
function logFailureDetails(url, response) {
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    headers[key] = value;
  }
  console.warn(
    `[redirectResolverService] Non-2xx response for ${url} | status=${response.status} ${response.statusText} | headers=${JSON.stringify(headers)}`
  );
}

/**
 * Issues a single request (HEAD or GET) with the shared timeout/headers and
 * releases its body immediately — we only ever need the final URL/status,
 * never the page content.
 */
async function issueRequest(url, method) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: REQUEST_HEADERS,
    });

    if (response.body) {
      response.body.cancel().catch(() => {});
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * A single HEAD-first/GET-fallback attempt at resolving one URL. Never
 * throws — timeouts, dead links, non-2xx final responses, and network
 * errors are all reported as a failure result.
 */
async function attemptResolve(url) {
  try {
    const headResponse = await issueRequest(url, 'HEAD');
    const isUsable = headResponse.status >= 200 && headResponse.status < 400 && Boolean(headResponse.url);
    if (isUsable) {
      return { resolvedWebsite: headResponse.url, resolutionStatus: 'resolved' };
    }
  } catch (_headError) {
    // HEAD isn't universally supported — fall through to GET below.
  }

  try {
    const getResponse = await issueRequest(url, 'GET');

    if (!getResponse.ok) {
      logFailureDetails(url, getResponse);
      return {
        resolvedWebsite: null,
        resolutionStatus: 'failed',
        resolutionError: `HTTP ${getResponse.status}`,
        httpStatus: getResponse.status,
      };
    }

    return { resolvedWebsite: getResponse.url, resolutionStatus: 'resolved' };
  } catch (error) {
    const reason = error.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : error.message;
    return {
      resolvedWebsite: null,
      resolutionStatus: 'failed',
      resolutionError: reason,
    };
  }
}

/**
 * Resolves one URL, retrying specifically on a 403 (a likely transient
 * rate-limit/bot-block signal from Cloudflare) up to MAX_403_ATTEMPTS times
 * with a short delay in between. Any other failure (404, timeout, network
 * error, etc.) is returned immediately without retrying — a repeat attempt
 * won't change those outcomes.
 */
async function resolveOneUrl(url) {
  let result;

  for (let attempt = 1; attempt <= MAX_403_ATTEMPTS; attempt += 1) {
    result = await attemptResolve(url);

    const isRetriable403 = result.resolutionStatus === 'failed' && result.httpStatus === 403;
    if (!isRetriable403 || attempt === MAX_403_ATTEMPTS) {
      break;
    }

    console.warn(
      `[redirectResolverService] HTTP 403 for ${url} (attempt ${attempt}/${MAX_403_ATTEMPTS}) — retrying after backoff...`
    );
    await sleep(RETRY_BASE_DELAY_MS * attempt);
  }

  delete result.httpStatus;
  return result;
}

/**
 * Resolves the `website` redirect link on every product to its final
 * destination URL, mutating and returning the same array with resolution
 * fields added:
 *   - success: { resolvedWebsite, resolutionStatus: 'resolved' }
 *   - failure: { resolvedWebsite: null, resolutionStatus: 'failed', resolutionError }
 *
 * Processes products in fixed-size batches (default 8) rather than a fully
 * rolling concurrency pool, with a short pause between batches — this
 * paces request volume/frequency to stay under Cloudflare's blocking
 * threshold in front of PH's /r/ links, which a rolling pool (constantly
 * starting a new request the instant a slot frees) does not.
 */
async function resolveRedirects(products, { concurrency = DEFAULT_CONCURRENCY, batchDelayMs = BATCH_DELAY_MS } = {}) {
  const total = products.length;

  if (total === 0) {
    return products;
  }

  console.log(
    `[redirectResolverService] Resolving redirects for ${total} product(s) ` +
      `(batch size=${concurrency}, delay between batches=${batchDelayMs}ms)...`
  );

  let processed = 0;
  let resolvedCount = 0;
  let failedCount = 0;
  let firstFailureLogged = false;

  for (let batchStart = 0; batchStart < total; batchStart += concurrency) {
    const batch = products.slice(batchStart, batchStart + concurrency);

    await Promise.all(
      batch.map(async (product) => {
        let result;
        if (!product.website) {
          result = {
            resolvedWebsite: null,
            resolutionStatus: 'failed',
            resolutionError: 'product has no website URL',
          };
        } else {
          result = await resolveOneUrl(product.website);
        }

        Object.assign(product, result);

        processed += 1;
        if (result.resolutionStatus === 'resolved') {
          resolvedCount += 1;
        } else {
          failedCount += 1;
          if (!firstFailureLogged) {
            firstFailureLogged = true;
            console.warn(
              `[redirectResolverService] First failure at item ${processed}/${total} ` +
                `(${product.resolutionError}) — url=${product.website}`
            );
          }
        }

        if (processed % PROGRESS_LOG_INTERVAL === 0 || processed === total) {
          console.log(
            `[redirectResolverService] Progress: ${processed}/${total} processed | ` +
              `resolved=${resolvedCount} | failed=${failedCount} | remaining=${total - processed}`
          );
        }
      })
    );

    const isLastBatch = batchStart + concurrency >= total;
    if (!isLastBatch && batchDelayMs > 0) {
      await sleep(batchDelayMs);
    }
  }

  return products;
}

module.exports = {
  resolveRedirects,
};
