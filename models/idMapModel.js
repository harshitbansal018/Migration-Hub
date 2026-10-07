// models/idMapModel.js
//
// `id_map` -- every old record and the Shopify record it became. Numbers and
// web addresses only, never names, emails or prices.
//
// Its five jobs: linking (an order finds its product's Shopify id here), no
// duplicates (one row per old record per connection), safe restarts, 301
// redirects (source_url -> shopify_handle), and recent-data / demo clean-up
// (source_hash, migration_id).
const { query, pool } = require("../config/db");

/**
 * Everything already migrated for some data types of one connection, as an
 * in-memory map -- one query instead of one per record. 50,000 orders' worth
 * of ids is a few MB.
 *
 *   map.get("products", 101) -> { gid, handle, hash, migrationId }
 */
async function loadMap(connectionId, entities) {
  const map = new Map();
  if (!entities.length) return wrap(map);

  const rows = await query(
    `SELECT entity, source_id, shopify_gid, shopify_handle, source_hash, migration_id
       FROM id_map
      WHERE source_connection_id = ? AND entity IN (?)`,
    [connectionId, entities]
  );
  for (const row of rows) {
    map.set(`${row.entity}:${row.source_id}`, {
      gid: row.shopify_gid,
      handle: row.shopify_handle,
      hash: row.source_hash,
      migrationId: row.migration_id,
    });
  }
  return wrap(map);
}

function wrap(map) {
  return {
    size: map.size,
    get: (entity, sourceId) => map.get(`${entity}:${sourceId}`) || null,
    set: (entity, sourceId, value) => map.set(`${entity}:${sourceId}`, value),
    has: (entity, sourceId) => map.has(`${entity}:${sourceId}`),
  };
}

async function find(connectionId, entity, sourceId) {
  const rows = await query(
    "SELECT * FROM id_map WHERE source_connection_id = ? AND entity = ? AND source_id = ? LIMIT 1",
    [connectionId, entity, String(sourceId)]
  );
  return rows[0] || null;
}

/** Record old id <-> Shopify id. A later run updating the record replaces it. */
async function save(rows) {
  if (!rows.length) return;
  const values = rows.map((row) => [
    row.storeId,
    row.connectionId,
    row.entity,
    String(row.sourceId).slice(0, 64),
    row.sourceUrl ? String(row.sourceUrl).slice(0, 512) : null,
    row.gid,
    row.handle ? String(row.handle).slice(0, 255) : null,
    row.hash || null,
    row.migrationId || null,
  ]);

  await pool.query(
    `INSERT INTO id_map
       (store_id, source_connection_id, entity, source_id, source_url,
        shopify_gid, shopify_handle, source_hash, migration_id)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       source_url = COALESCE(VALUES(source_url), source_url),
       shopify_gid = VALUES(shopify_gid),
       shopify_handle = COALESCE(VALUES(shopify_handle), shopify_handle),
       source_hash = VALUES(source_hash),
       migration_id = VALUES(migration_id)`,
    [values]
  );
}

/** Old addresses that should redirect, with where they now live. */
async function redirectSources(connectionId) {
  return query(
    `SELECT entity, source_id, source_url, shopify_handle, migration_id
       FROM id_map
      WHERE source_connection_id = ?
        AND source_url IS NOT NULL AND shopify_handle IS NOT NULL
        AND entity IN ('collections','products','pages','posts')
      ORDER BY id`,
    [connectionId]
  );
}

async function countRedirectSources(connectionId) {
  const rows = await query(
    `SELECT COUNT(*) AS total FROM id_map
      WHERE source_connection_id = ? AND source_url IS NOT NULL AND shopify_handle IS NOT NULL
        AND entity IN ('collections','products','pages','posts')`,
    [connectionId]
  );
  return Number(rows[0].total) || 0;
}

/** What a demo created, newest-dependent first so orders go before products. */
async function listByMigration(migrationId) {
  return query(
    `SELECT id, entity, source_id, shopify_gid FROM id_map
      WHERE migration_id = ?
      ORDER BY FIELD(entity,'redirects','orders','customers','coupons','posts','pages','variant','products','collections'), id`,
    [migrationId]
  );
}

async function deleteRows(ids) {
  if (!ids.length) return;
  await pool.query("DELETE FROM id_map WHERE id IN (?)", [ids]);
}

/** Of these source ids, which are now in Shopify (a retry fixed them). */
async function presentIds(connectionId, entity, sourceIds) {
  if (!sourceIds.length) return new Set();
  const rows = await query(
    "SELECT source_id FROM id_map WHERE source_connection_id = ? AND entity = ? AND source_id IN (?)",
    [connectionId, entity, sourceIds.map(String)]
  );
  return new Set(rows.map((row) => row.source_id));
}

module.exports = {
  loadMap,
  find,
  save,
  redirectSources,
  countRedirectSources,
  listByMigration,
  deleteRows,
  presentIds,
};
