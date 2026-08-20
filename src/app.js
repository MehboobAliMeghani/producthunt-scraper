const express = require('express');
const scrapeRoutes = require('./routes/scrapeRoutes');

const app = express();

app.use(express.json());

app.use('/api/scrape', scrapeRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;
