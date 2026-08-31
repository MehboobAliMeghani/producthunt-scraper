/**
 * CLI runner for getTodaysProducts() (+ optional website discovery +
 * optional email scraping + optional email filtering), for testing the
 * scraper without spinning up the Express server.
 *
 * Website discovery uses a real headless Chromium browser (via Playwright)
 * to load each product's Product Hunt page and extract its outbound
 * website link — this requires the Chromium browser binary to be installed
 * locally (`npx playwright install --with-deps chromium`), not just the
 * `playwright` npm package. See README for details.
 *
 * Usage:
 *   npm run scrape:test                                   # fetch only
 *   npm run scrape:test -- --resolve                       # fetch, then discover outbound websites (full batch)
 *   npm run scrape:test -- --resolve --limit=5              # discover only the first N products —
 *                                                            # use this to sanity-check against a
 *                                                            # handful of real PH product pages
 *                                                            # before running the full batch
 *   npm run scrape:test -- --resolve --emails               # fetch, resolve, then scrape emails via Apify
 *                                                            # (requires APIFY_API_TOKEN; --emails is a no-op
 *                                                            # without --resolve, since it needs resolvedWebsite)
 *   npm run scrape:test -- --resolve --emails --filter       # ...then curate the scraped emails down to
 *                                                            # a final selection (--filter is a no-op
 *                                                            # without --emails, since it needs raw emails)
 */
const { getTodaysProducts } = require('../src/services/productHuntService');
const { discoverWebsites } = require('../src/services/websiteDiscoveryService');
const { scrapeEmails } = require('../src/services/emailScraperService');
const { filterEmails } = require('../src/services/emailFilterService');

const shouldResolve = process.argv.includes('--resolve');
const shouldScrapeEmails = process.argv.includes('--emails');
const shouldFilterEmails = process.argv.includes('--filter');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

(async () => {
  try {
    const products = await getTodaysProducts();
    console.log(`Fetched ${products.length} product(s) posted today:\n`);
    console.log(JSON.stringify(products, null, 2));

    if (products.length === 0) {
      console.log('\nNo products found for today\'s date range.');
      return;
    }

    console.log(`\nScraped ${products.length} products from Product Hunt (today's date range).`);

    if (!shouldResolve) {
      return;
    }

    const productsToResolve = limit ? products.slice(0, limit) : products;
    if (limit) {
      console.log(`\n--limit=${limit} passed — only resolving the first ${productsToResolve.length} product(s).`);
    }

    console.log('\nDiscovering outbound websites from Product Hunt product pages...\n');
    const startedAt = Date.now();
    const resolved = await discoverWebsites(productsToResolve);
    const elapsedMs = Date.now() - startedAt;

    const resolvedCount = resolved.filter((p) => p.resolutionStatus === 'resolved').length;
    const failedCount = resolved.filter((p) => p.resolutionStatus === 'failed').length;

    console.log('\n' + JSON.stringify(resolved, null, 2));
    console.log('\nWebsite discovery summary:');
    console.log(`  Total products:  ${resolved.length}`);
    console.log(`  Resolved:        ${resolvedCount}`);
    console.log(`  Failed:          ${failedCount}`);
    console.log(`  Time taken:      ${(elapsedMs / 1000).toFixed(1)}s`);

    if (!shouldScrapeEmails) {
      return;
    }

    console.log('\nScraping contact emails for resolved websites via Apify...\n');
    const emailsStartedAt = Date.now();
    const { products: withEmails, summary } = await scrapeEmails(resolved);
    const emailsElapsedMs = Date.now() - emailsStartedAt;

    console.log('\n' + JSON.stringify(withEmails, null, 2));
    console.log('\nEmail scraping summary:');
    console.log(`  Sent to Apify:     ${summary.totalSentToApify}`);
    console.log(`  Matched:           ${summary.matched}`);
    console.log(`  No emails found:   ${summary.noEmailsFound}`);
    console.log(`  Skipped:           ${summary.skipped}`);
    console.log(`  Apify run status:  ${summary.apifyRunStatus}`);
    console.log(`  Time taken:        ${(emailsElapsedMs / 1000).toFixed(1)}s`);

    if (!shouldFilterEmails) {
      return;
    }

    console.log('\nFiltering scraped emails down to a final curated selection...\n');
    const { products: filtered, summary: filterSummary } = filterEmails(withEmails);

    console.log('\n' + JSON.stringify(filtered, null, 2));
    console.log('\nEmail filtering summary:');
    console.log(`  Products with raw emails:  ${filterSummary.totalProductsWithRawEmails}`);
    console.log(`  Products after filtering:  ${filterSummary.totalAfterFiltering}`);
    console.log(`  Emails kept:               ${filterSummary.totalEmailsKept}`);
    console.log(`  Emails removed:            ${filterSummary.totalEmailsRemoved}`);
    console.log(`    malformed:      ${filterSummary.removedByReason.malformed}`);
    console.log(`    placeholder:    ${filterSummary.removedByReason.placeholder}`);
    console.log(`    role_address:   ${filterSummary.removedByReason.role_address}`);
    console.log(`    exceeded_cap:   ${filterSummary.removedByReason.exceeded_cap}`);
  } catch (error) {
    console.error('scrape:test failed:', error.message);
    process.exitCode = 1;
  }
})();
