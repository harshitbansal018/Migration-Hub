// services/migration/sources/http.js
//
// How we talk to a merchant's OLD store. Two concerns:
//
// 1. The address is typed by a merchant, so it is untrusted. It must be
//    https, and it must not resolve to our own network (localhost, 10.x,
//    169.254.169.254 cloud metadata, ...) -- otherwise the "Test connection"
//    button is a way to make our server fetch internal URLs (SSRF).
//
// 2. Old stores are often on cheap hosting. We ask for small pages, pause
//    between requests, and retry 429 / 5xx / timeouts with backoff instead
//    of hammering a struggling server.
const dns = require("dns").promises;
const net = require("net");
const axios = require("axios");

const TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS || 30000);
const MAX_ATTEMPTS = Number(process.env.SOURCE_MAX_ATTEMPTS || 5);
const PAUSE_MS = Number(process.env.SOURCE_PAUSE_MS || 250);
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_SOURCES === "true";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error whose message is safe and useful to show the merchant. */
class SourceError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = "SourceError";
    this.status = status;
    this.retryable = retryable;
    this.userFacing = true;
  }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  return (
    lower === "::1" || lower === "::" ||
    lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") ||
    lower.startsWith("::ffff:") && isPrivateAddress(lower.slice(7))
  );
}

/**
 * Clean up what the merchant typed into a base URL, or throw a SourceError
 * that says what is wrong. "myshop.com/" becomes "https://myshop.com".
 */
async function normalizeBaseUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new SourceError("Enter your store's address, e.g. https://myshop.com");
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError("That does not look like a web address.");
  }

  if (url.protocol !== "https:") {
    throw new SourceError(
      "Your store must use https:// — API keys must never be sent over an unencrypted connection."
    );
  }
  if (url.username || url.password) throw new SourceError("Remove the username and password from the address.");

  const host = url.hostname.toLowerCase();
  if (!ALLOW_PRIVATE) {
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new SourceError("That address is not reachable from the internet.");
    }
    let addresses;
    try {
      addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    } catch {
      throw new SourceError(`We could not find ${host}. Check the address for typos.`);
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new SourceError("That address is not reachable from the internet.");
    }
  }

  // WordPress may live in a sub-folder (example.com/shop), so keep the path.
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** The merchant-friendly reason for a failed response. */
function describe(error, what) {
  const status = error.response && error.response.status;
  if (status === 401 || status === 403) {
    return new SourceError(
      `Your old store refused the keys (${status}). Check they are correct and have Read permission.`,
      { status }
    );
  }
  if (status === 404) {
    return new SourceError(
      `${what} was not found on your old store (404). Check the address, and that permalinks are not set to "Plain".`,
      { status }
    );
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return new SourceError(`Your old store is overloaded or down (${status}).`, { status, retryable: true });
  }
  if (!error.response) {
    return new SourceError(
      error.code === "ECONNABORTED" || /timeout/i.test(error.message || "")
        ? "Your old store took too long to answer."
        : `Could not reach your old store (${error.code || error.message}).`,
      { retryable: true }
    );
  }
  return new SourceError(`Your old store answered with an error (${status}).`, { status });
}

/**
 * GET a JSON endpoint on the old store, retrying what a retry can fix.
 * Returns { data, headers }.
 */
async function getJson(url, { params, auth, headers, what = "That page", onRetry } = {}) {
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.get(url, {
        params,
        auth,
        headers: { Accept: "application/json", "User-Agent": "ShopifyMigrationApp/1.0", ...headers },
        timeout: TIMEOUT_MS,
        maxRedirects: 3,
        // Large catalogues can return big pages; cap at 25 MB a page.
        maxContentLength: 25 * 1024 * 1024,
        validateStatus: (status) => status >= 200 && status < 300,
      });

      // A WordPress site with a broken plugin often answers 200 with an HTML
      // page instead of JSON. Treat that as an error with a clear message.
      if (typeof response.data === "string") {
        throw new SourceError(
          `${what} returned a web page instead of data. The REST API may be blocked by a security plugin.`
        );
      }

      if (PAUSE_MS) await sleep(PAUSE_MS);
      return { data: response.data, headers: response.headers };
    } catch (error) {
      lastError = error.userFacing ? error : describe(error, what);
      if (!lastError.retryable || attempt === MAX_ATTEMPTS - 1) break;

      const retryAfter = Number(error.response && error.response.headers["retry-after"]);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60000)
        : Math.min(1000 * 2 ** attempt, 30000) + Math.round(Math.random() * 500);

      if (onRetry) onRetry(lastError, wait, attempt + 1);
      await sleep(wait);
    }
  }

  throw lastError;
}

/** WordPress / WooCommerce pagination headers. */
function totals(headers) {
  return {
    total: Number(headers["x-wp-total"]) || 0,
    totalPages: Number(headers["x-wp-totalpages"]) || 0,
  };
}

/** Only the path of an old URL — what a Shopify redirect matches on. */
function pathOf(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + (parsed.search || "");
    return path === "/" ? null : decodeURI(path).slice(0, 512);
  } catch {
    return null;
  }
}

module.exports = {
  SourceError,
  normalizeBaseUrl,
  getJson,
  totals,
  pathOf,
  isPrivateAddress,
};
