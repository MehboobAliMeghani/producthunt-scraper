# ProductHunt Scraper — Backend

Node.js/Express backend for a Product Hunt scraping pipeline. This step
implements only the Product Hunt data fetch stage; later steps will chain
email discovery, Google Sheets export, OpenAI enrichment, and GMass sending
on top of it.

## Project structure

```
.
├── server.js                     # Express entry point
├── scripts/
│   └── scrapeTest.js             # CLI runner: npm run scrape:test
├── src/
│   ├── app.js                    # Express app + route wiring
│   ├── config/
│   │   └── env.js                # Centralized env var access
│   ├── routes/
│   │   └── scrapeRoutes.js       # GET /api/scrape/preview
│   ├── services/
│   │   ├── productHuntService.js       # PH GraphQL client — getTodaysProducts()
│   │   └── websiteDiscoveryService.js  # Playwright-driven outbound website discovery
│   └── jobs/                     # (empty — for future scheduled jobs)
├── .env.example
└── package.json
```

## Setup

```bash
npm install
cp .env.example .env   # then fill in PRODUCT_HUNT_API_TOKEN
```

### Playwright browser binaries

Website discovery (`websiteDiscoveryService.js`) drives a real headless
Chromium browser via [Playwright](https://playwright.dev) to load each
product's Product Hunt page. `npm install` only installs the `playwright`
npm package — it does **not** download the actual browser binary. Run this
once after `npm install`, both locally and as part of the build step on
Render (or any deploy target):

```bash
npx playwright install --with-deps chromium
```

Without this step, `discoverWebsites()` will fail immediately since Chromium
has nothing to launch.

### Getting a Product Hunt API token

1. Go to https://www.producthunt.com/v2/oauth/applications and log in.
2. Click **Add an application** and fill in the required fields (name,
   redirect URL — for local testing you can use `http://localhost:3000`).
3. Once created, open the application and copy the **Developer Token**.
   This is a long-lived token suitable for server-to-server use — no OAuth
   redirect flow needed for this use case.
4. Paste it into `.env`:
   ```
   PRODUCT_HUNT_API_TOKEN=your_token_here
   ```

The token is sent as a `Bearer` token on every request to
`https://api.producthunt.com/v2/api/graphql`. Never commit `.env` or the
token itself — `.env` is already git-ignored.

## Running

Start the server:

```bash
npm start
# or, with auto-reload:
npm run dev
```

Then hit the manual test endpoint:

```
GET http://localhost:3000/api/scrape/preview
```

This is a **temporary** endpoint for verifying the scraper works — it will
be replaced once the full pipeline API is designed.

### Testing from the CLI (no server needed)

```bash
npm run scrape:test
```

This runs `getTodaysProducts()` directly and logs the resulting JSON array
to the console.

## What `getTodaysProducts()` does

- Authenticates to the PH v2 GraphQL API with a Bearer token.
- Queries the `posts` field, filtered with `postedAfter` / `postedBefore`
  set to today's UTC date range.
- Follows cursor-based pagination (`pageInfo.hasNextPage` /
  `pageInfo.endCursor`) until all of today's posts are collected.
- Retries automatically on rate limiting (HTTP 429) and transient server
  errors (5xx), with exponential backoff (and respects a `Retry-After`
  header when PH sends one). Other errors (bad auth, malformed query, etc.)
  fail immediately with a descriptive error message.
- Returns a clean array of:
  ```js
  { id, name, tagline, description, website, productHuntUrl, votesCount }
  ```
