// models/storeModel.js
//
// The `stores` table. One row per installed Shopify store.
//
// Access and refresh tokens are ENCRYPTED at this boundary: callers pass and
// receive plaintext, and nothing outside this file sees the ciphertext.
const { query, pool } = require("../config/db");
const { encrypt, decrypt } = require("../utils/crypto");
const { toDate } = require("./helpers");

const DEFAULT_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

/**
 * Decrypt the token columns on the way out. A token that fails to decrypt
 * (key rotated, row tampered with) surfaces as null so the caller treats the
 * store as needing a reinstall rather than sending garbage to Shopify.
 */
function hydrate(row) {
  if (!row) return null;

  const store = { ...row };

  for (const column of ["access_token", "refresh_token"]) {
    try {
      store[column] = decrypt(row[column]);
    } catch (err) {
      console.warn(
        `Could not decrypt ${column} for ${row.shop_domain}: ${err.message}`
      );
      store[column] = null;
    }
  }

  store.is_active = Boolean(row.is_active);
  return store;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function findByDomain(shopDomain) {
  const rows = await query(
    "SELECT * FROM stores WHERE shop_domain = ? LIMIT 1",
    [String(shopDomain || "").trim().toLowerCase()]
  );
  return hydrate(rows[0]);
}

async function findById(id) {
  const rows = await query("SELECT * FROM stores WHERE id = ? LIMIT 1", [id]);
  return hydrate(rows[0]);
}

async function listAll() {
  const rows = await query(
    "SELECT * FROM stores ORDER BY is_active DESC, store_name, shop_domain"
  );
  return rows.map(hydrate);
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

const UPSERT_SQL = `
  INSERT INTO stores (
    shop_domain, store_name,
    access_token, access_token_expires_at,
    refresh_token, refresh_token_expires_at,
    api_version, currency,
    is_active, installed_at, uninstalled_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
  ON DUPLICATE KEY UPDATE
    store_name = VALUES(store_name),
    access_token = VALUES(access_token),
    access_token_expires_at = VALUES(access_token_expires_at),
    refresh_token = VALUES(refresh_token),
    refresh_token_expires_at = VALUES(refresh_token_expires_at),
    api_version = VALUES(api_version),
    currency = VALUES(currency),
    is_active = 1,
    -- A reinstall clears the uninstall marker but keeps the original
    -- installed_at, so "customer since" stays truthful.
    uninstalled_at = NULL
`;

/** Create or refresh a store row at install time. */
async function upsertStore(data) {
  await query(UPSERT_SQL, [
    String(data.shop_domain).trim().toLowerCase(),
    data.store_name || null,
    encrypt(data.access_token),
    toDate(data.access_token_expires_at),
    encrypt(data.refresh_token),
    toDate(data.refresh_token_expires_at),
    data.api_version || DEFAULT_API_VERSION,
    data.currency || null,
    toDate(data.installed_at) || new Date(),
  ]);

  return findByDomain(data.shop_domain);
}

/** Persist a rotated token pair after a refresh. */
async function updateTokens(shopDomain, tokens) {
  await query(
    `UPDATE stores
        SET access_token = ?,
            access_token_expires_at = ?,
            refresh_token = ?,
            refresh_token_expires_at = ?
      WHERE shop_domain = ?`,
    [
      encrypt(tokens.accessToken),
      toDate(tokens.accessTokenExpiresAt),
      encrypt(tokens.refreshToken),
      toDate(tokens.refreshTokenExpiresAt),
      shopDomain,
    ]
  );
}

/** Drop a dead token pair. The store row stays for its history. */
async function clearTokens(shopDomain) {
  await query(
    `UPDATE stores
        SET access_token = NULL,
            access_token_expires_at = NULL,
            refresh_token = NULL,
            refresh_token_expires_at = NULL
      WHERE shop_domain = ?`,
    [shopDomain]
  );
}

/**
 * app/uninstalled: deactivate and stamp the time, and clear the revoked
 * tokens. The row stays so a reinstall resumes rather than starting over.
 */
async function markUninstalled(shopDomain) {
  await query(
    `UPDATE stores
        SET is_active = 0,
            uninstalled_at = NOW(),
            access_token = NULL,
            access_token_expires_at = NULL,
            refresh_token = NULL,
            refresh_token_expires_at = NULL
      WHERE shop_domain = ?`,
    [shopDomain]
  );
}

/** shop/redact: cascades to every table that references this store. */
async function deleteStore(shopDomain) {
  const [result] = await pool.query("DELETE FROM stores WHERE shop_domain = ?", [
    shopDomain,
  ]);
  return result.affectedRows > 0;
}

/** The store owner's email, as Shopify reports it. */
async function setEmail(id, email) {
  await query("UPDATE stores SET email = ? WHERE id = ?", [
    email ? String(email).trim().slice(0, 255) : null,
    id,
  ]);
}

/**
 * Stop opening the app on the setup screen.
 *
 * Set when the merchant finishes setup, and equally when they skip it -- the
 * column answers "should the app still open here", not "is setup complete".
 * Whether the steps are done is read from the store's own data every time.
 *
 * Written once: a second call leaves the first date alone.
 */
async function markOnboarded(id) {
  await query(
    "UPDATE stores SET onboarded_at = NOW() WHERE id = ? AND onboarded_at IS NULL",
    [id]
  );
}

module.exports = {
  setEmail,
  markOnboarded,
  findByDomain,
  findById,
  listAll,
  upsertStore,
  updateTokens,
  clearTokens,
  markUninstalled,
  deleteStore,
};
