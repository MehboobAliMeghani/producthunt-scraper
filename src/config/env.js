// Centralized environment config. Loaded once, everywhere else just imports
// this module instead of touching process.env directly.
require('dotenv').config();

const env = {
  PORT: process.env.PORT || 3000,
  PRODUCT_HUNT_API_TOKEN: process.env.PRODUCT_HUNT_API_TOKEN || '',
  PRODUCT_HUNT_GRAPHQL_URL:
    process.env.PRODUCT_HUNT_GRAPHQL_URL || 'https://api.producthunt.com/v2/api/graphql',
  // Hard safety cap on how many pages a single pagination loop may fetch.
  // Prevents a pagination bug (bad cursor, ordering by a live-changing
  // metric, server ignoring a filter, etc.) from silently burning the
  // entire rate limit again.
  PRODUCT_HUNT_MAX_PAGES: Number(process.env.PRODUCT_HUNT_MAX_PAGES) || 100,
  // Fixed delay between successive page requests. PH's rate limit quota
  // appears to replenish gradually over time rather than only resetting at
  // a fixed 15-min window boundary, so pacing requests below full speed
  // keeps a multi-page run from cliff-diving into a 429.
  PRODUCT_HUNT_PAGE_DELAY_MS: Number(process.env.PRODUCT_HUNT_PAGE_DELAY_MS) || 3000,
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || '',
  // How often emailScraperService polls an in-progress Apify actor run.
  APIFY_POLL_INTERVAL_MS: Number(process.env.APIFY_POLL_INTERVAL_MS) || 20000,
};

module.exports = env;
