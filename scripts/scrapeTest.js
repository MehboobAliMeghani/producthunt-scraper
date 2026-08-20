/**
 * CLI runner for getTodaysProducts(), for testing the scraper without
 * spinning up the Express server. Usage: npm run scrape:test
 */
const { getTodaysProducts } = require('../src/services/productHuntService');

(async () => {
  try {
    const products = await getTodaysProducts();
    console.log(`Fetched ${products.length} product(s) posted today:\n`);
    console.log(JSON.stringify(products, null, 2));

    if (products.length === 0) {
      console.log('\nNo products found for today\'s date range.');
    } else {
      console.log(`\nScraped ${products.length} products from Product Hunt (today's date range).`);
    }
  } catch (error) {
    console.error('scrape:test failed:', error.message);
    process.exitCode = 1;
  }
})();
