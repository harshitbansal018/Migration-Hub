// models/migrationModel.js
//
// `migrations` (one run) and `migration_steps` (one data type within a run).
//
// Screens read through the store-scoped functions (every query carries
// store_id, so one shop can never see another's runs). The worker uses the
// claim / touch / release functions at the bottom.
const { query, pool, withTransaction } = require("../config/db");
const { parseJson } = require("./helpers");
const { BY_KEY, STALE_LOCK_MINUTES } = require("../services/migration/constants");

const ACTIVE = ["queued", "running", "paused"];

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    entities: parseJson(row.entities, []) || [],
    options: parseJson(row.options, {}) || {},
    scan_counts: row.scan_counts !== undefined ? parseJson(row.scan_counts, {}) || {} : undefined,
  };
}

function hydrateStep(row) {
  const entity = BY_KEY[row.entity] || { label: row.entity };
  return {
    ...row,
    label: entity.label,
    remaining: Math.max(0, Number(row.total) - Number(row.processed)),
    percent: row.total > 0 ? Math.min(100, Math.round((Number(row.processed) / Number(row.total)) * 100)) : row.status === "done" ? 100 : 0,
  };
}

const SELECT_WITH_CONNECTION = `
  SELECT m.*, c.platform, c.base_url, c.credentials_hint, c.source_version, c.scan_counts,
         c.status AS connection_status,
         COALESCE(t.total, 0) AS step_total, COALESCE(t.processed, 0) AS step_processed,
         COALESCE(t.succeeded, 0) AS succeeded, COALESCE(t.failed, 0) AS failed,
         COALESCE(t.skipped, 0) AS skipped
    FROM migrations m
    LEFT JOIN source_connections c ON c.id = m.source_connection_id
    LEFT JOIN (
      SELECT migration_id, SUM(total) AS total, SUM(processed) AS processed,
             SUM(succeeded) AS succeeded, SUM(failed) AS failed, SUM(skipped) AS skipped
        FROM migration_steps GROUP BY migration_id
    ) t ON t.migration_id = m.id`;

/* ------------------------------------------------------------------ */
/* reads                                                               */
/* ------------------------------------------------------------------ */

async function findForStore(storeId, id) {
  const rows = await query(`${SELECT_WITH_CONNECTION} WHERE m.id = ? AND m.store_id = ? LIMIT 1`, [id, storeId]);
  return hydrate(rows[0]);
}

async function findById(id) {
  const rows = await query(`${SELECT_WITH_CONNECTION} WHERE m.id = ? LIMIT 1`, [id]);
  return hydrate(rows[0]);
}

/** The Migrations list. `filter`: all | running | completed | failed | drafts */
async function listForStore(storeId, { filter = "all", limit = 100 } = {}) {
  const where = {
    all: "",
    running: "AND m.status IN ('queued','running','paused')",
    completed: "AND m.status = 'completed'",
    failed: "AND m.status IN ('failed','cancelled')",
    drafts: "AND m.status = 'draft'",
  }[filter] || "";

  const rows = await query(
    `${SELECT_WITH_CONNECTION} WHERE m.store_id = ? ${where} ORDER BY m.id DESC LIMIT ?`,
    [storeId, limit]
  );
  return rows.map(hydrate);
}

/** Counts for the list's filter tabs and the dashboard cards. */
async function statusCounts(storeId) {
  const rows = await query(
    `SELECT status, type, COUNT(*) AS n, MAX(finished_at) AS last_finished, MAX(started_at) AS last_started
       FROM migrations WHERE store_id = ? GROUP BY status, type`,
    [storeId]
  );
  const counts = { all: 0, running: 0, completed: 0, failed: 0, drafts: 0, demo: 0, full: 0, lastCompleted: null, runningSince: null };
  for (const row of rows) {
    const n = Number(row.n);
    if (row.status === "draft") {
      counts.drafts += n;
      continue;
    }
    counts.all += n;
    if (row.type === "demo") counts.demo += n;
    else counts.full += n;
    if (ACTIVE.includes(row.status)) {
      counts.running += n;
      if (row.last_started && (!counts.runningSince || row.last_started > counts.runningSince)) counts.runningSince = row.last_started;
    }
    if (row.status === "completed") {
      counts.completed += n;
      if (row.last_finished && (!counts.lastCompleted || row.last_finished > counts.lastCompleted)) counts.lastCompleted = row.last_finished;
    }
    if (row.status === "failed" || row.status === "cancelled") counts.failed += n;
  }
  return counts;
}

/** Moved and failed per data type, demos excluded: the dashboard's cards. */
async function entityTotals(storeId) {
  const rows = await query(
    `SELECT s.entity, SUM(s.succeeded) AS succeeded, SUM(s.failed) AS failed, SUM(s.skipped) AS skipped
       FROM migration_steps s JOIN migrations m ON m.id = s.migration_id
      WHERE m.store_id = ? AND m.type <> 'demo'
      GROUP BY s.entity`,
    [storeId]
  );
  return Object.fromEntries(
    rows.map((row) => [row.entity, { succeeded: Number(row.succeeded) || 0, failed: Number(row.failed) || 0, skipped: Number(row.skipped) || 0 }])
  );
}

/** Records moved this calendar month, demos excluded: what a plan limits. */
async function monthUsage(storeId) {
  const rows = await query(
    `SELECT COALESCE(SUM(s.succeeded), 0) AS used
       FROM migration_steps s JOIN migrations m ON m.id = s.migration_id
      WHERE m.store_id = ? AND m.type <> 'demo' AND s.entity <> 'redirects'
        AND m.started_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`,
    [storeId]
  );
  return Number(rows[0].used) || 0;
}

/** The run the dashboard banner talks about. */
async function activeForStore(storeId) {
  const rows = await query(
    `${SELECT_WITH_CONNECTION}
      WHERE m.store_id = ? AND m.status IN ('running','queued','paused')
      ORDER BY FIELD(m.status,'running','queued','paused'), m.id DESC LIMIT 1`,
    [storeId]
  );
  return hydrate(rows[0]);
}

async function hasCompletedDemo(storeId) {
  const rows = await query(
    "SELECT id FROM migrations WHERE store_id = ? AND type = 'demo' AND status = 'completed' LIMIT 1",
    [storeId]
  );
  return Boolean(rows[0]);
}

async function steps(migrationId) {
  const rows = await query("SELECT * FROM migration_steps WHERE migration_id = ? ORDER BY position", [migrationId]);
  return rows.map(hydrateStep);
}

/* ------------------------------------------------------------------ */
/* the wizard                                                          */
/* ------------------------------------------------------------------ */

async function createDraft(storeId, { connectionId = null, type = "full", wizardStep = 1, options = {}, entities = [] } = {}) {
  const [result] = await pool.query(
    `INSERT INTO migrations (store_id, source_connection_id, type, status, wizard_step, entities, options)
     VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
    [storeId, connectionId, type, wizardStep, JSON.stringify(entities), JSON.stringify(options)]
  );
  return result.insertId;
}

/** Update a draft. Refuses anything that has already begun. */
async function updateDraft(storeId, id, fields) {
  const allowed = ["source_connection_id", "wizard_step", "entities", "options", "type", "total_records"];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(key === "entities" || key === "options" ? JSON.stringify(fields[key]) : fields[key]);
  }
  if (!sets.length) return;
  params.push(id, storeId);
  await query(`UPDATE migrations SET ${sets.join(", ")} WHERE id = ? AND store_id = ? AND status = 'draft'`, params);
}

async function deleteDraft(storeId, id) {
  const [result] = await pool.query("DELETE FROM migrations WHERE id = ? AND store_id = ? AND status = 'draft'", [id, storeId]);
  return result.affectedRows > 0;
}

/**
 * Begin: the run joins the queue, with one step per data type in the fixed
 * order. Only a draft can begin, and only once -- the status check is in the
 * UPDATE itself, so a double click cannot queue it twice.
 */
async function queue(storeId, id, { type, totalRecords, storagePath, entities, options, parentId = null }) {
  return withTransaction(async (connection) => {
    const [result] = await connection.query(
      `UPDATE migrations
          SET status = 'queued', type = ?, total_records = ?, storage_path = ?, entities = ?,
              options = ?, parent_migration_id = COALESCE(?, parent_migration_id), phase = 'export'
        WHERE id = ? AND store_id = ? AND status = 'draft'`,
      [type, totalRecords, storagePath, JSON.stringify(entities), JSON.stringify(options), parentId, id, storeId]
    );
    if (!result.affectedRows) return false;

    const rows = entities.map((entity) => [id, entity, BY_KEY[entity].position, "pending"]);
    if (rows.length) {
      await connection.query("INSERT IGNORE INTO migration_steps (migration_id, entity, position, status) VALUES ?", [rows]);
    }
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

/**
 * Pause / resume / cancel, each only from the states it makes sense in.
 * The worker notices within one page of 50 records.
 */
async function control(storeId, id, action) {
  const transitions = {
    pause: { from: ["queued", "running"], to: "paused" },
    resume: { from: ["paused", "failed"], to: "queued" },
    cancel: { from: ["queued", "running", "paused"], to: "cancelled" },
  };
  const rule = transitions[action];
  if (!rule) return false;

  const [result] = await pool.query(
    `UPDATE migrations
        SET status = ?, last_error = IF(? = 'queued', NULL, last_error),
            finished_at = IF(? = 'cancelled', UTC_TIMESTAMP(), finished_at),
            locked_at = IF(? = 'queued', NULL, locked_at),
            worker_id = IF(? = 'queued', NULL, worker_id)
      WHERE id = ? AND store_id = ? AND status IN (?)`,
    [rule.to, rule.to, rule.to, rule.to, rule.to, id, storeId, rule.from]
  );
  return result.affectedRows > 0;
}

/* ------------------------------------------------------------------ */
/* the worker                                                          */
/* ------------------------------------------------------------------ */

/** How many runs hold a fresh lock across every worker. */
async function runningCount() {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM migrations
      WHERE status = 'running' AND locked_at >= UTC_TIMESTAMP() - INTERVAL ? MINUTE`,
    [STALE_LOCK_MINUTES]
  );
  return Number(rows[0].n) || 0;
}

/**
 * Take the next run off the queue. Oldest first; never two runs of the same
 * shop at once; a "running" run whose lock went stale (its worker died) is
 * picked up again and carries on from its saved position.
 *
 * The claim is one conditional UPDATE: if two workers race for the same run,
 * exactly one of them changes the row.
 */
async function claimNext(workerId) {
  const candidates = await query(
    `SELECT m.id FROM migrations m
      WHERE (m.status = 'queued'
             OR (m.status = 'running' AND (m.locked_at IS NULL OR m.locked_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)))
        AND NOT EXISTS (
          SELECT 1 FROM migrations o
           WHERE o.store_id = m.store_id AND o.id <> m.id AND o.status = 'running'
             AND o.locked_at >= UTC_TIMESTAMP() - INTERVAL ? MINUTE)
        AND NOT EXISTS (
          SELECT 1 FROM migrations e
           WHERE e.store_id = m.store_id AND e.id < m.id AND e.status = 'queued')
      ORDER BY m.id LIMIT 5`,
    [STALE_LOCK_MINUTES, STALE_LOCK_MINUTES]
  );

  for (const { id } of candidates) {
    const [result] = await pool.query(
      `UPDATE migrations
          SET status = 'running', worker_id = ?, locked_at = UTC_TIMESTAMP(),
              started_at = COALESCE(started_at, UTC_TIMESTAMP())
        WHERE id = ?
          AND (status = 'queued'
               OR (status = 'running' AND (locked_at IS NULL OR locked_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)))`,
      [workerId, id, STALE_LOCK_MINUTES]
    );
    if (result.affectedRows) return findById(id);
  }
  return null;
}

/**
 * Heartbeat, once a page. Returns the run's status, or null when this worker
 * no longer holds it -- then it must stop at once.
 */
async function touch(id, workerId) {
  const [result] = await pool.query(
    "UPDATE migrations SET locked_at = UTC_TIMESTAMP() WHERE id = ? AND worker_id = ?",
    [id, workerId]
  );
  if (!result.affectedRows) return null;
  const rows = await query("SELECT status FROM migrations WHERE id = ?", [id]);
  return rows[0] ? rows[0].status : null;
}

async function release(id, workerId) {
  await query("UPDATE migrations SET worker_id = NULL, locked_at = NULL WHERE id = ? AND worker_id = ?", [id, workerId]);
}

async function setPhase(id, phase) {
  await query("UPDATE migrations SET phase = ? WHERE id = ?", [phase, id]);
}

async function finish(id, workerId, { status, error = null, personalDays, otherDays }) {
  await query(
    `UPDATE migrations
        SET status = ?, last_error = ?, phase = IF(? = 'completed', 'done', phase),
            finished_at = UTC_TIMESTAMP(),
            personal_files_expire_at = UTC_TIMESTAMP() + INTERVAL ? DAY,
            files_expire_at = UTC_TIMESTAMP() + INTERVAL ? DAY,
            worker_id = NULL, locked_at = NULL
      WHERE id = ? AND (worker_id = ? OR ? IS NULL)`,
    [status, error ? String(error).slice(0, 512) : null, status, personalDays, otherDays, id, workerId, workerId]
  );
}

/** A run stopped by an error. It can be resumed from where it stopped. */
async function fail(id, workerId, error) {
  await query(
    `UPDATE migrations SET status = 'failed', last_error = ?, worker_id = NULL, locked_at = NULL
      WHERE id = ? AND worker_id = ?`,
    [String(error).slice(0, 512), id, workerId]
  );
}

async function updateStep(stepId, fields) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value && typeof value === "object" && value.raw) {
      sets.push(`${key} = ${value.raw}`);
    } else {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (!sets.length) return;
  params.push(stepId);
  await query(`UPDATE migration_steps SET ${sets.join(", ")} WHERE id = ?`, params);
}

async function setOption(id, key, value) {
  const rows = await query("SELECT options FROM migrations WHERE id = ?", [id]);
  if (!rows[0]) return;
  const options = parseJson(rows[0].options, {}) || {};
  options[key] = value;
  await query("UPDATE migrations SET options = ? WHERE id = ?", [JSON.stringify(options), id]);
}

/* ------------------------------------------------------------------ */
/* retention                                                           */
/* ------------------------------------------------------------------ */

async function personalFilesDue() {
  return query(
    `SELECT id, storage_path FROM migrations
      WHERE storage_path IS NOT NULL AND files_deleted_at IS NULL AND personal_files_deleted_at IS NULL
        AND personal_files_expire_at IS NOT NULL AND personal_files_expire_at < UTC_TIMESTAMP()`
  );
}

async function foldersDue() {
  return query(
    `SELECT id, storage_path FROM migrations
      WHERE storage_path IS NOT NULL AND files_deleted_at IS NULL
        AND files_expire_at IS NOT NULL AND files_expire_at < UTC_TIMESTAMP()`
  );
}

async function markPersonalDeleted(id) {
  await query("UPDATE migrations SET personal_files_deleted_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
}

async function markFilesDeleted(id) {
  await query(
    `UPDATE migrations SET files_deleted_at = UTC_TIMESTAMP(),
            personal_files_deleted_at = COALESCE(personal_files_deleted_at, UTC_TIMESTAMP())
      WHERE id = ?`,
    [id]
  );
}

async function storagePathsForStore(storeId) {
  return query("SELECT id, storage_path FROM migrations WHERE store_id = ? AND storage_path IS NOT NULL", [storeId]);
}

module.exports = {
  ACTIVE,
  findForStore,
  findById,
  listForStore,
  statusCounts,
  entityTotals,
  monthUsage,
  activeForStore,
  hasCompletedDemo,
  steps,
  createDraft,
  updateDraft,
  deleteDraft,
  queue,
  control,
  runningCount,
  claimNext,
  touch,
  release,
  setPhase,
  finish,
  fail,
  updateStep,
  setOption,
  personalFilesDue,
  foldersDue,
  markPersonalDeleted,
  markFilesDeleted,
  storagePathsForStore,
};
