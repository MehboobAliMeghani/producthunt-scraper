const express = require('express');
const { getTodaysProducts } = require('../services/productHuntService');
const { resolveRedirects } = require('../services/redirectResolverService');

const router = express.Router();

/**
 * GET /api/scrape/preview
 *
 * Temporary manual-testing endpoint — calls getTodaysProducts(), then
 * resolveRedirects() on the results, and returns the combined JSON array.
 * Not the final API shape; just here to verify the pipeline works
 * end-to-end before later stages (email discovery, Sheets export, etc.)
 * are chained on.
 */
router.get('/preview', async (req, res) => {
  try {
    const products = await getTodaysProducts();
    const resolved = await resolveRedirects(products);
    res.json(resolved);
  } catch (error) {
    console.error('[scrape:preview] failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
