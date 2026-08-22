const express = require('express');
const { getTodaysProducts } = require('../services/productHuntService');
const { resolveRedirects } = require('../services/redirectResolverService');
const { scrapeEmails } = require('../services/emailScraperService');
const { filterEmails } = require('../services/emailFilterService');

const router = express.Router();

/**
 * GET /api/scrape/preview
 *
 * Temporary manual-testing endpoint — calls getTodaysProducts(), then
 * resolveRedirects() on the results, and returns the combined JSON array.
 * Not the final API shape; just here to verify the pipeline works
 * end-to-end before later stages (Sheets export, etc.) are chained on.
 *
 * Query params:
 *   ?emails=true  also runs scrapeEmails() on the resolved products
 *                 (requires APIFY_API_TOKEN to be set).
 *   ?filter=true  also runs filterEmails() on the scraped products, curating
 *                 the raw emails down to a final selection (no-op unless
 *                 emails=true is also set, since it needs raw emails).
 */
router.get('/preview', async (req, res) => {
  try {
    const products = await getTodaysProducts();
    const resolved = await resolveRedirects(products);

    if (req.query.emails !== 'true') {
      res.json(resolved);
      return;
    }

    const { products: withEmails, summary: emailSummary } = await scrapeEmails(resolved);

    if (req.query.filter !== 'true') {
      res.json({ products: withEmails, emailSummary });
      return;
    }

    const { products: filtered, summary: filterSummary } = filterEmails(withEmails);
    res.json({ products: filtered, emailSummary, filterSummary });
  } catch (error) {
    console.error('[scrape:preview] failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
