// services/migration/converters/common.js
//
// Small, pure helpers every converter shares. No I/O here, so they are all
// easy to unit-test.
const crypto = require("crypto");

/** Fingerprint of an old record: a delta run moves only what changed. */
function hashRecord(record) {
  return crypto.createHash("sha1").update(JSON.stringify(record)).digest("hex");
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

/** WordPress returns titles HTML-encoded ("Tea &#038; Co"). Shopify wants text. */
function decodeEntities(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .trim();
}

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

/** A Shopify handle: lowercase letters, digits and dashes. */
function toHandle(value) {
  return String(decodeURIComponent(String(value || "")))
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

/** "8" -> "8.00"; null for anything that is not a price. */
function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

/** "2024-03-01T10:00:00" (GMT, no zone) -> ISO with Z. */
function gmtIso(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Only an E.164 phone is accepted on a Shopify customer. */
function e164(phone) {
  const cleaned = String(phone || "").replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(cleaned) ? cleaned : null;
}

function cleanEmail(email) {
  const text = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

/** Drop null / undefined / empty-string keys, so Shopify gets clean input. */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

/** A WooCommerce / WordPress address -> Shopify MailingAddressInput. */
function address(source) {
  if (!source) return null;
  const result = compact({
    firstName: source.first_name,
    lastName: source.last_name,
    company: source.company,
    address1: source.address_1,
    address2: source.address_2,
    city: source.city,
    provinceCode: source.state ? String(source.state).slice(0, 10) : null,
    countryCode: source.country ? String(source.country).toUpperCase().slice(0, 2) : null,
    zip: source.postcode,
    phone: source.phone ? String(source.phone).slice(0, 40) : null,
  });
  return result.address1 || result.city || result.countryCode ? result : null;
}

const sameAddress = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Not converted, and why. `kind` is failed unless deliberately skipped. */
const fail = (reason) => ({ fail: reason });
const skip = (reason) => ({ skip: reason });

module.exports = {
  hashRecord,
  decodeEntities,
  stripTags,
  toHandle,
  money,
  gmtIso,
  e164,
  cleanEmail,
  compact,
  address,
  sameAddress,
  fail,
  skip,
};
