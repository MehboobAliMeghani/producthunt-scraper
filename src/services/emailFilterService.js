/**
 * emailFilterService.js
 *
 * Takes the products array produced by emailScraperService (each with a raw
 * `emails` array) and applies cleaning/filtering rules, replacing the raw
 * scraped emails with a final curated selection (max 2) per product. Pure
 * in-memory logic — no network calls.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Exact placeholder addresses that don't fit a shared placeholder domain
// (e.g. bob@gmail.com — gmail.com itself is a legitimate personal domain,
// so only this specific address is blocked).
const PLACEHOLDER_EMAILS = new Set(['sarah@acme.com', 'johndoe@company.com', 'bob@gmail.com', 'you@gmail.com']);

// Whole domains that only ever show up as boilerplate/example placeholders.
const PLACEHOLDER_DOMAINS = new Set(['acme.com', 'acme.corp', 'example.com', 'company.com', 'test.com', 'yourco.com']);

// Role-based inboxes, not a contact for a person — dropped regardless of
// domain.
const ROLE_LOCAL_PARTS = new Set([
  'privacy',
  'press',
  'editorial',
  'legal',
  'security',
  'billing',
  'dmarc',
  'ads',
  'jobs',
  'hiring',
  'career',
  'tips',
  'accreditation',
  'impact',
  'research',
  'dataprivacy',
  'compliance',
  'abuse',
  'noreply',
]);

// Consumer email providers — an email on one of these (base) domains is
// classified "personal" rather than "business".
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'mail.ru',
  '163.com',
  'qq.com',
]);

const TIER0_LOCAL_PARTS = new Set(['contact', 'info', 'hello', 'hi']);
const TIER1_LOCAL_PARTS = new Set(['sales', 'partners', 'bd', 'founder', 'team', 'ceo']);
const TIER3_LOCAL_PARTS = new Set(['support', 'admin', 'office', 'help', 'service']);

// "first.last"-style local part — exactly one dot separating two word-like
// segments.
const NAMED_INDIVIDUAL_REGEX = /^[a-z0-9]+\.[a-z0-9]+$/;

/**
 * True if `raw` should be discarded as malformed: not a string, fails the
 * basic shape check, contains a literal "%20", has stray internal
 * whitespace, or has more than one "@".
 */
function isMalformed(raw) {
  if (typeof raw !== 'string') {
    return true;
  }
  if (raw.includes('%20')) {
    return true;
  }
  const trimmed = raw.trim();
  if (/\s/.test(trimmed)) {
    return true;
  }
  const atCount = (trimmed.match(/@/g) || []).length;
  if (atCount !== 1) {
    return true;
  }
  return !EMAIL_REGEX.test(trimmed);
}

/**
 * True if `normalized` (trimmed + lowercased) is a known placeholder
 * address, either by exact match or by placeholder domain.
 */
function isPlaceholder(normalized) {
  if (PLACEHOLDER_EMAILS.has(normalized)) {
    return true;
  }
  const domain = normalized.split('@')[1];
  return Boolean(domain) && PLACEHOLDER_DOMAINS.has(domain);
}

/**
 * Domain with subdomains stripped down to the last two labels (good enough
 * for every domain on PERSONAL_DOMAINS, which are all two-label).
 */
function getBaseDomain(domain) {
  const parts = domain.split('.');
  return parts.length <= 2 ? domain : parts.slice(-2).join('.');
}

function classifyType(domain) {
  if (!domain) {
    return 'business';
  }
  return PERSONAL_DOMAINS.has(getBaseDomain(domain)) ? 'personal' : 'business';
}

/**
 * Priority tier for a local part (0 = best), or null if it doesn't match
 * any tier and is therefore never eligible for selection.
 */
function getTier(localPart) {
  if (TIER0_LOCAL_PARTS.has(localPart)) {
    return 0;
  }
  if (TIER1_LOCAL_PARTS.has(localPart)) {
    return 1;
  }
  if (NAMED_INDIVIDUAL_REGEX.test(localPart)) {
    return 2;
  }
  if (TIER3_LOCAL_PARTS.has(localPart)) {
    return 3;
  }
  return null;
}

/**
 * Strips `ref` query params (e.g. ?ref=producthunt, &ref=producthunt) from
 * a resolved website URL. Returns the URL unchanged if it isn't parseable.
 */
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
 * Runs one product's raw `emails` array through validation, role-address
 * removal, classification, and tiered selection (max 2). Returns
 * { filteredEmails, removedEmails }.
 */
function filterProductEmails(rawEmails) {
  const removedEmails = [];
  const survivors = [];

  rawEmails.forEach((raw, index) => {
    if (isMalformed(raw)) {
      removedEmails.push({ email: raw, reason: 'malformed' });
      return;
    }

    const normalized = raw.trim().toLowerCase();

    if (isPlaceholder(normalized)) {
      removedEmails.push({ email: normalized, reason: 'placeholder' });
      return;
    }

    const localPart = normalized.split('@')[0];
    if (ROLE_LOCAL_PARTS.has(localPart)) {
      removedEmails.push({ email: normalized, reason: 'role_address' });
      return;
    }

    const domain = normalized.split('@')[1];
    survivors.push({
      email: normalized,
      type: classifyType(domain),
      tier: getTier(localPart),
      index,
    });
  });

  const eligible = survivors.filter((s) => s.tier !== null);
  eligible.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.type !== b.type) {
      return a.type === 'business' ? -1 : 1;
    }
    return a.index - b.index;
  });

  const selected = eligible.slice(0, 2);
  const selectedEmails = new Set(selected.map((s) => s.email));

  for (const survivor of survivors) {
    if (!selectedEmails.has(survivor.email)) {
      removedEmails.push({ email: survivor.email, reason: 'exceeded_cap' });
    }
  }

  const filteredEmails = selected.map((s) => ({ email: s.email, type: s.type, tier: s.tier }));

  return { filteredEmails, removedEmails };
}

/**
 * Cleans resolvedWebsite (strips ref= query params) on every product, and
 * for each product with raw emails, validates/filters/classifies them down
 * to a curated `filteredEmails` (max 2), attaching the results back onto
 * each product object (mutating and returning the same objects), plus a
 * run summary.
 *
 * Returns { products, summary }.
 */
function filterEmails(products) {
  let totalProductsWithRawEmails = 0;
  let totalEmailsKept = 0;
  let totalEmailsRemoved = 0;
  const removedByReason = { malformed: 0, placeholder: 0, role_address: 0, exceeded_cap: 0 };

  for (const product of products) {
    product.resolvedWebsite = stripRefParam(product.resolvedWebsite);

    const rawEmails = Array.isArray(product.emails) ? product.emails : [];

    if (rawEmails.length === 0) {
      product.filteredEmails = [];
      product.emailCount = 0;
      product.removedEmails = [];
      continue;
    }

    totalProductsWithRawEmails += 1;

    const { filteredEmails, removedEmails } = filterProductEmails(rawEmails);

    product.filteredEmails = filteredEmails;
    product.emailCount = filteredEmails.length;
    product.removedEmails = removedEmails;

    totalEmailsKept += filteredEmails.length;
    totalEmailsRemoved += removedEmails.length;
    for (const removed of removedEmails) {
      removedByReason[removed.reason] += 1;
    }
  }

  const totalAfterFiltering = products.filter((product) => product.emailCount > 0).length;

  return {
    products,
    summary: {
      totalProductsWithRawEmails,
      totalAfterFiltering,
      totalEmailsKept,
      totalEmailsRemoved,
      removedByReason,
    },
  };
}

module.exports = {
  filterEmails,
};
