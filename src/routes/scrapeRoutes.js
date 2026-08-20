const express = require('express');
const { getTodaysProducts } = require('../services/productHuntService');

const router = express.Router();

/**
 * GET /api/scrape/preview
 *
 * Temporary manual-testing endpoint — calls getTodaysProducts() and returns
 * the raw JSON array. Not the final API shape; just here to verify the
 * scraper works end-to-end before later pipeline stages are chained on.
 */
router.get('/preview', async (req, res) => {
  try {
    const products = await getTodaysProducts();
    res.json(products);
  } catch (error) {
    console.error('[scrape:preview] failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

module.exports = router;
