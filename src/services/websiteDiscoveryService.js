/**
 * websiteDiscoveryService.js
 *
 * Replaces redirectResolverService: Product Hunt's /r/... redirect links are
 * now blocked by Cloudflare regardless of headers/IP, so instead of
 * following that redirect chain, this module loads each product's actual
 * Product Hunt page in a real headless browser (Cloudflare only blocks
 * plain HTTP clients, not a real browser) and extracts the outbound website
 * link directly from the rendered page — a `<a href="...?ref=producthunt">`
 * anchor.
 *
 * Uses a single shared browser instance across all products (launching a
 * full browser process per product would be extremely wasteful of memory),
 * but opens a fresh, isolated browser *context* (Playwright's equivalent of
 * an incognito window — its own cookie jar/storage, no state shared with
 * other contexts) per product rather than a plain new page/tab on one
 * shared context.
 *
 * This isn't just cleanliness: testing against real PH product pages showed
 * Product Hunt's Cloudflare check lets the first request through on a given
 * browser context, then serves a "Just a moment..." JS challenge to every
 * subsequent request reusing that same context — even sequential ones with
 * multi-second gaps between them. A fresh context per product (still one
 * underlying browser process — a context is cheap, not a new OS process)
 * reliably avoided this in testing (8/8 resolved). Processes products in
 * small batches since each context+page still carries real memory cost.
 */

const { chromium } = require('playwright');

const DEFAULT_CONCURRENCY = Number(process.env.PLAYWRIGHT_CONCURRENCY) || 3;
const PAGE_GOTO_TIMEOUT_MS = 15_000;
const PROGRESS_LOG_INTERVAL = 50;

// Product Hunt's Cloudflare check serves a "Just a moment..." JS challenge
// page instead of the real product page specifically when it detects
// Playwright's default headless fingerprint (navigator.webdriver,
// --headless's automation-controlled flag, the "HeadlessChrome" UA token) —
// confirmed by testing headless with vs. without these three tells against
// the same product page. None of this touches Cloudflare's IP/volume-based
// blocking (what took down the old redirect resolver) — it only clears the
// separate headless-fingerprint check, so the page is reachable at all.
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];
const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Same ref-param-stripping rule as emailFilterService's stripRefParam,
// applied here so resolvedWebsite is already clean by the time it reaches
// later pipeline stages.
function stripRefParam(url) {
  if (typeof url !== 'string' || !url) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('ref');
    return parsed.toString();
  } catch (_error) {
    return url;
  }
}

/**
 * Loads one product's Product Hunt page — in its own fresh browser context,
 * see module docstring for why — and extracts the first outbound link whose
 * href contains "?ref=producthunt". Never throws — every failure mode
 * (timeout, navigation error, no matching link) is returned as a failure
 * result.
 */
async function discoverOneWebsite(browser, product) {
  if (!product.productHuntUrl) {
    return { resolvedWebsite: null, resolutionStatus: 'failed', resolutionError: 'product has no productHuntUrl' };
  }

  const context = await browser.newContext({ userAgent: REALISTIC_USER_AGENT });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    await page.goto(product.productHuntUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });

    const href = await page.evaluate(() => {
      const anchor = document.querySelector('a[href*="?ref=producthunt"]');
      return anchor ? anchor.href : null;
    });

    if (!href) {
      return { resolvedWebsite: null, resolutionStatus: 'failed', resolutionError: 'no outbound link found on page' };
    }

    return { resolvedWebsite: stripRefParam(href), resolutionStatus: 'resolved' };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? `timeout after ${PAGE_GOTO_TIMEOUT_MS}ms` : error.message;
    return { resolvedWebsite: null, resolutionStatus: 'failed', resolutionError: reason };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Discovers the outbound website link for every product by loading its
 * Product Hunt page in a shared headless Chromium browser, mutating and
 * returning the same array with resolution fields added:
 *   - success: { resolvedWebsite, resolutionStatus: 'resolved' }
 *   - failure: { resolvedWebsite: null, resolutionStatus: 'failed', resolutionError }
 *
 * Processes products in small fixed-size batches (default 3, configurable
 * via PLAYWRIGHT_CONCURRENCY) since each open tab consumes real memory.
 */
async function discoverWebsites(products, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const total = products.length;

  if (total === 0) {
    return products;
  }

  console.log(`[websiteDiscoveryService] Discovering websites for ${total} product(s) (concurrency=${concurrency})...`);

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });

  let processed = 0;
  let resolvedCount = 0;
  let failedCount = 0;

  try {
    for (let batchStart = 0; batchStart < total; batchStart += concurrency) {
      const batch = products.slice(batchStart, batchStart + concurrency);

      await Promise.all(
        batch.map(async (product) => {
          const result = await discoverOneWebsite(browser, product);
          Object.assign(product, result);

          processed += 1;
          if (result.resolutionStatus === 'resolved') {
            resolvedCount += 1;
          } else {
            failedCount += 1;
          }

          if (processed % PROGRESS_LOG_INTERVAL === 0 || processed === total) {
            console.log(
              `[websiteDiscoveryService] Progress: ${processed}/${total} processed | ` +
                `resolved=${resolvedCount} | failed=${failedCount} | remaining=${total - processed}`
            );
          }
        })
      );
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return products;
}

module.exports = {
  discoverWebsites,
};
