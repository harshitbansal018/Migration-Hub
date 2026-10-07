// models/sourceConnectionModel.js
//
// `source_connections` -- the merchant's OLD store.
//
// The API keys are encrypted at this boundary (AES-256-GCM, utils/crypto.js)
// and only ever decrypted for the worker and the connection test. Everything
// a screen reads goes through hydrate(), which drops them: the browser gets
// `credentials_hint` ("ck_4f9a…c21e") and nothing else.
const { query, pool } = require("../config/db");
const { encrypt, decrypt } = require("../utils/crypto");
const { parseJson } = require("./helpers");

function hydrate(row) {
  if (!row) return null;
  const { credentials, ...rest } = row;
  return { ...rest, scan_counts: parseJson(row.scan_counts, {}) || {} };
}

/** The row WITH decrypted keys. Server-side use only. */
function withCredentials(row) {
  if (!row) return null;
  let credentials = {};
  try {
    credentials = parseJson(decrypt(row.credentials), {}) || {};
  } catch (err) {
    console.warn(`Could not decrypt keys for connection ${row.id}: ${err.message}`);
  }
  return { ...hydrate(row), credentials };
}

async function findForStore(storeId, id) {
  const rows = await query("SELECT * FROM source_connections WHERE id = ? AND store_id = ? LIMIT 1", [id, storeId]);
  return hydrate(rows[0]);
}

async function findWithCredentials(id) {
  const rows = await query("SELECT * FROM source_connections WHERE id = ? LIMIT 1", [id]);
  return withCredentials(rows[0]);
}

async function listForStore(storeId) {
  const rows = await query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM migrations m WHERE m.source_connection_id = c.id AND m.status <> 'draft') AS migration_count
       FROM source_connections c
      WHERE c.store_id = ?
      ORDER BY c.status = 'connected' DESC, c.updated_at DESC`,
    [storeId]
  );
  return rows.map(hydrate);
}

/** The connection the store used last, for the Setup and Migrations screens. */
async function latestConnected(storeId, platform = null) {
  const rows = await query(
    `SELECT * FROM source_connections
      WHERE store_id = ? AND status = 'connected' ${platform ? "AND platform = ?" : ""}
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
    platform ? [storeId, platform] : [storeId]
  );
  return hydrate(rows[0]);
}

/**
 * Save the result of a connection test. One row per (store, platform,
 * address): testing the same store again updates it, so its id_map -- and
 * with it "no duplicates" -- carries over.
 */
async function saveTest({ storeId, platform, baseUrl, credentials, hint, ok, version, counts, error }) {
  const existing = await query(
    "SELECT id FROM source_connections WHERE store_id = ? AND platform = ? AND base_url = ? LIMIT 1",
    [storeId, platform, baseUrl]
  );

  const values = {
    credentials: encrypt(JSON.stringify(credentials || {})),
    credentials_hint: hint || null,
    status: ok ? "connected" : "failed",
    last_error: ok ? null : String(error || "").slice(0, 512),
    source_version: version ? String(version).slice(0, 64) : null,
    scan_counts: counts ? JSON.stringify(counts) : null,
  };

  if (existing[0]) {
    // A failed re-test must not wipe the counts and version of the last good one.
    if (!ok) {
      await query(
        "UPDATE source_connections SET status = 'failed', last_error = ?, last_tested_at = NOW() WHERE id = ?",
        [values.last_error, existing[0].id]
      );
    } else {
      await query(
        `UPDATE source_connections
            SET credentials = ?, credentials_hint = ?, status = ?, last_error = ?,
                source_version = ?, scan_counts = ?, last_tested_at = NOW()
          WHERE id = ?`,
        [values.credentials, values.credentials_hint, values.status, values.last_error,
          values.source_version, values.scan_counts, existing[0].id]
      );
    }
    return findForStore(storeId, existing[0].id);
  }

  const [result] = await pool.query(
    `INSERT INTO source_connections
       (store_id, platform, base_url, credentials, credentials_hint, status, last_error,
        source_version, scan_counts, last_tested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [storeId, platform, baseUrl, values.credentials, values.credentials_hint, values.status,
      values.last_error, values.source_version, values.scan_counts]
  );
  return findForStore(storeId, result.insertId);
}

/**
 * Disconnect: the keys go, and -- by the foreign keys -- so do this
 * connection's migrations and its id_map rows.
 */
async function remove(storeId, id) {
  const [result] = await pool.query("DELETE FROM source_connections WHERE id = ? AND store_id = ?", [id, storeId]);
  return result.affectedRows > 0;
}

module.exports = {
  findForStore,
  findWithCredentials,
  listForStore,
  latestConnected,
  saveTest,
  remove,
};
