/**
 * emailScraperService.js
 *
 * Takes the array of products produced by productHuntService +
 * redirectResolverService (each with a resolvedWebsite / resolutionStatus)
 * and runs the resolved websites through an Apify contact-scraper actor to
 * find contact emails, then attaches the results back onto each product.
 *
 * Talks to Apify's REST API directly (not the apify-client SDK) so this
 * stays a plain fetch-based module like the rest of the pipeline.
 */

const { APIFY_API_TOKEN, APIFY_POLL_INTERVAL_MS } = require('../config/env');

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const APIFY_ACTOR_ID = 'QrqE4kfyNa4tFLJ1M';

const START_RUN_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 15_000;
const DATASET_PAGE_TIMEOUT_MS = 30_000;
const DATASET_PAGE_SIZE = 1000;

// Statuses Apify reports while a run is still in flight. Anything else
// (SUCCEEDED, FAILED, ABORTED, TIMED-OUT, ...) is terminal.
const IN_PROGRESS_STATUSES = new Set(['READY', 'RUNNING', 'RESTARTING']);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Placeholder/example addresses the actor sometimes scrapes off boilerplate
// contact-page templates — not real contact emails, so never surface them.
const DISALLOWED_EMAIL_DOMAINS = new Set([
  'example.com',
  'startup.com',
  'email.com',
  'yourcompany.com',
  'domain.com',
  'test.com',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${APIFY_API_TOKEN}` };
}

/**
 * True if `email` is syntactically valid and not on the disallowed
 * placeholder-domain list (example.com, test.com, etc.).
 */
function isValidEmail(email) {
  if (typeof email !== 'string') {
    return false;
  }
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmed)) {
    return false;
  }
  const domain = trimmed.split('@')[1];
  return Boolean(domain) && !DISALLOWED_EMAIL_DOMAINS.has(domain);
}

/**
 * Validates + dedupes a dataset item's raw `emails` array, preserving first-
 * seen order (so `[0]` is a stable choice for primaryEmail).
 */
function extractValidEmails(rawEmails) {
  if (!Array.isArray(rawEmails)) {
    return [];
  }
  const seen = new Set();
  const valid = [];
  for (const raw of rawEmails) {
    if (typeof raw !== 'string') {
      continue;
    }
    const normalized = raw.trim().toLowerCase();
    if (!isValidEmail(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    valid.push(normalized);
  }
  return valid;
}

/**
 * Hostname of a URL, lowercased with a leading "www." stripped, or null if
 * `url` isn't parseable. Used as the fallback match key since the actor may
 * normalize the URLs we sent it (scheme, www, trailing slash, path).
 */
function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_error) {
    return null;
  }
}

/**
 * Starts the Apify actor run (fire-and-poll — waitForFinish=0) and returns
 * the run object from the response (`{ id, status, defaultDatasetId, ... }`).
 */
async function startApifyRun(urls) {
  const response = await fetchWithTimeout(
    `${APIFY_BASE_URL}/acts/${APIFY_ACTOR_ID}/runs?waitForFinish=0`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify({
        urls,
        followContactPages: true,
        maxContactPages: 3,
        requestTimeoutSecs: 30,
      }),
    },
    START_RUN_TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to start Apify actor run (HTTP ${response.status}): ${body}`);
  }

  const payload = await response.json();
  return payload.data;
}

/**
 * Polls GET /actor-runs/{runId} every APIFY_POLL_INTERVAL_MS, logging each
 * poll's status, until the run reaches a terminal status. Returns the final
 * run object.
 */
async function pollRunUntilFinished(runId) {
  let run;

  while (true) {
    const response = await fetchWithTimeout(
      `${APIFY_BASE_URL}/actor-runs/${runId}`,
      { headers: authHeaders() },
      POLL_TIMEOUT_MS
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Failed to poll Apify run status (HTTP ${response.status}): ${body}`);
    }

    const payload = await response.json();
    run = payload.data;

    console.log(
      `[emailScraperService] Apify run ${runId} status=${run.status} ` +
        `(polling again in ${APIFY_POLL_INTERVAL_MS}ms if still in progress)`
    );

    if (!IN_PROGRESS_STATUSES.has(run.status)) {
      break;
    }

    await sleep(APIFY_POLL_INTERVAL_MS);
  }

  return run;
}

/**
 * Fetches every item from an Apify dataset, paginating in pages of
 * DATASET_PAGE_SIZE until a page comes back short.
 */
async function fetchAllDatasetItems(datasetId) {
  const items = [];
  let offset = 0;

  while (true) {
    const url =
      `${APIFY_BASE_URL}/datasets/${datasetId}/items` +
      `?clean=1&offset=${offset}&limit=${DATASET_PAGE_SIZE}&format=json`;

    const response = await fetchWithTimeout(url, { headers: authHeaders() }, DATASET_PAGE_TIMEOUT_MS);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Failed to fetch Apify dataset items (HTTP ${response.status}): ${body}`);
    }

    const page = await response.json();
    items.push(...page);

    if (page.length < DATASET_PAGE_SIZE) {
      break;
    }
    offset += DATASET_PAGE_SIZE;
  }

  return items;
}

/**
 * Runs every product's resolvedWebsite through the Apify contact-scraper
 * actor and attaches the results back onto each product object (mutating
 * and returning the same objects), plus a run summary.
 *
 * Products are only sent to Apify if resolutionStatus === 'resolved'; the
 * rest are marked emailScraped: false / emailMatchStatus: 'skipped_no_website'
 * and never touch the network call.
 *
 * Returns { products, summary }.
 */
async function scrapeEmails(products) {
  const sendable = products.filter((product) => product.resolutionStatus === 'resolved' && product.resolvedWebsite);
  const skipped = products.length - sendable.length;

  for (const product of products) {
    if (!(product.resolutionStatus === 'resolved' && product.resolvedWebsite)) {
      product.emailScraped = false;
      product.emailMatchStatus = 'skipped_no_website';
      product.emails = [];
      product.primaryEmail = null;
    }
  }

  if (sendable.length === 0) {
    console.warn('[emailScraperService] No products with a resolved website — skipping the Apify run entirely.');
    return {
      products,
      summary: {
        totalSentToApify: 0,
        matched: 0,
        noEmailsFound: 0,
        skipped,
        apifyRunStatus: null,
        // TODO: Apify's actor-run API response doesn't expose per-run cost/
        // usage billing for this actor — wire this up if/when that becomes
        // available.
        cost: null,
      },
    };
  }

  if (!APIFY_API_TOKEN) {
    throw new Error('APIFY_API_TOKEN is not set. Add it to your .env file.');
  }

  const urlToProducts = new Map();
  const hostnameToProducts = new Map();

  for (const product of sendable) {
    const url = product.resolvedWebsite;

    if (!urlToProducts.has(url)) {
      urlToProducts.set(url, []);
    }
    urlToProducts.get(url).push(product);

    const hostname = getHostname(url);
    if (hostname) {
      if (!hostnameToProducts.has(hostname)) {
        hostnameToProducts.set(hostname, []);
      }
      hostnameToProducts.get(hostname).push(product);
    }

    // Default state, overwritten below for whichever products a dataset
    // item ends up matching. Anything still 'unmatched' after processing
    // the dataset genuinely never got a result back from the actor.
    product.emailScraped = true;
    product.emails = [];
    product.primaryEmail = null;
    product.emailMatchStatus = 'unmatched';
  }

  const dedupedUrls = Array.from(urlToProducts.keys());

  console.log(
    `[emailScraperService] Starting Apify actor run for ${dedupedUrls.length} unique URL(s) ` +
      `(from ${sendable.length} product(s))...`
  );

  const startedRun = await startApifyRun(dedupedUrls);
  console.log(`[emailScraperService] Apify run started: id=${startedRun.id} status=${startedRun.status}`);

  const finishedRun = await pollRunUntilFinished(startedRun.id);
  console.log(`[emailScraperService] Apify run finished: status=${finishedRun.status}`);

  const datasetItems = finishedRun.defaultDatasetId ? await fetchAllDatasetItems(finishedRun.defaultDatasetId) : [];

  for (const item of datasetItems) {
    if (!item || typeof item.url !== 'string') {
      console.warn(
        '[emailScraperService] Dataset item missing a url field — skipping.' +
          (item && item.error ? ` error=${item.error}` : '')
      );
      continue;
    }

    let matchedProducts = urlToProducts.get(item.url);
    if (!matchedProducts) {
      const hostname = getHostname(item.url);
      matchedProducts = hostname ? hostnameToProducts.get(hostname) : undefined;
    }

    if (!matchedProducts || matchedProducts.length === 0) {
      console.warn(`[emailScraperService] Dataset item for ${item.url} did not match any sent product — dropping.`);
      continue;
    }

    const validEmails = extractValidEmails(item.emails);

    for (const product of matchedProducts) {
      product.emails = validEmails;
      product.primaryEmail = validEmails[0] || null;
      product.emailMatchStatus = validEmails.length > 0 ? 'matched' : 'no_emails_found';
    }
  }

  const matched = sendable.filter((product) => product.emailMatchStatus === 'matched').length;
  const noEmailsFound = sendable.filter((product) => product.emailMatchStatus === 'no_emails_found').length;
  const unmatched = sendable.filter((product) => product.emailMatchStatus === 'unmatched').length;

  if (finishedRun.status !== 'SUCCEEDED') {
    console.warn(
      `[emailScraperService] Apify run ended with non-success status "${finishedRun.status}" — ` +
        `processing the partial dataset anyway. ${matched + noEmailsFound}/${sendable.length} product(s) got a ` +
        `result; ${unmatched} are missing results because of the incomplete run.`
    );
  }

  return {
    products,
    summary: {
      totalSentToApify: sendable.length,
      matched,
      noEmailsFound,
      skipped,
      apifyRunStatus: finishedRun.status,
      // TODO: Apify's actor-run API response doesn't expose per-run cost/
      // usage billing for this actor — wire this up if/when that becomes
      // available.
      cost: null,
    },
  };
}

module.exports = {
  scrapeEmails,
};
