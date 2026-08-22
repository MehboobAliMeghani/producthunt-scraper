/**
 * CLI runner for getTodaysProducts() (+ optional redirect resolution), for
 * testing the scraper without spinning up the Express server.
 *
 * Usage:
 *   npm run scrape:test                        # fetch only
 *   npm run scrape:test -- --resolve           # fetch, then resolve redirect links (full batch)
 *   npm run scrape:test -- --resolve --limit=5 # resolve only the first N products —
 *                                               # use this to sanity-check against a
 *                                               # handful of real PH redirect links
 *                                               # before running the full batch
 */
const { getTodaysProducts } = require('../src/services/productHuntService');
const { resolveRedirects } = require('../src/services/redirectResolverService');

const shouldResolve = process.argv.includes('--resolve');
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

    console.log('\nResolving redirect links to their final destination URLs...\n');
    const startedAt = Date.now();
    const resolved = await resolveRedirects(productsToResolve);
    const elapsedMs = Date.now() - startedAt;

    const resolvedCount = resolved.filter((p) => p.resolutionStatus === 'resolved').length;
    const failedCount = resolved.filter((p) => p.resolutionStatus === 'failed').length;

    console.log('\n' + JSON.stringify(resolved, null, 2));
    console.log('\nRedirect resolution summary:');
    console.log(`  Total products:  ${resolved.length}`);
    console.log(`  Resolved:        ${resolvedCount}`);
    console.log(`  Failed:          ${failedCount}`);
    console.log(`  Time taken:      ${(elapsedMs / 1000).toFixed(1)}s`);
  } catch (error) {
    console.error('scrape:test failed:', error.message);
    process.exitCode = 1;
  }
})();
