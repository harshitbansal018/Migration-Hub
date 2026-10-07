// controllers/migrationController.js
//
// The Migrations menu: the list, the 5-step wizard, the progress screen and
// the results screen -- plus the actions behind their buttons.
//
// One URL per migration, /migrations/:id, shows whatever fits its status:
//   draft                      -> the wizard, at the step it was left on
//   queued / running / paused  -> progress
//   completed / failed / cancelled -> results
//
// Every query is scoped to req.storeId, so one shop can never see or touch
// another's migrations.
const migrationModel = require("../models/migrationModel");
const sourceConnectionModel = require("../models/sourceConnectionModel");
const idMapModel = require("../models/idMapModel");
const planLimits = require("../services/planLimits");
const storage = require("../services/migration/storage");
const demoCleanup = require("../services/migration/demoCleanup");
const { adapterFor, CREDENTIALS, normalizeBaseUrl } = require("../services/migration/sources");
const C = require("../services/migration/constants");

const FILTERS = ["all", "running", "completed", "failed", "drafts"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function base(req) {
  return { shop: req.shop, apiKey: process.env.SHOPIFY_API_KEY, store: req.store };
}

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function load(req) {
  const id = idParam(req);
  return id ? migrationModel.findForStore(req.storeId, id) : null;
}

function jsonError(res, status, error, extra = {}) {
  return res.status(status).json({ error, ...extra });
}

/** Counts a screen may show: never the connection's private `_meta`. */
function publicCounts(counts) {
  return Object.fromEntries(Object.entries(counts || {}).filter(([key]) => !key.startsWith("_")));
}

/** How many records each chosen data type is expected to have. */
function estimates(migration, counts) {
  const out = {};
  for (const entity of migration.entities) {
    if (entity === "redirects") continue;
    let count = Number(counts[entity]) || 0;
    if (entity === "orders" && migration.options.orders_range === "range" && Number.isFinite(migration.options.orders_count)) {
      count = migration.options.orders_count;
    }
    out[entity] = count;
  }
  return out;
}

function totalOf(estimate, type) {
  return Object.values(estimate).reduce((sum, count) => sum + (type === "demo" ? Math.min(count, C.DEMO_LIMIT) : count), 0);
}

/** "about 35–50 minutes", from records per minute we typically reach. */
function eta(total) {
  if (!total) return "a few minutes";
  const low = Math.max(1, Math.round(total / 150));
  const high = Math.max(low + 1, Math.round(total / 105));
  if (high < 2) return "about a minute";
  if (low >= 120) return `about ${Math.round(low / 60)}–${Math.round(high / 60)} hours`;
  return `about ${low}–${high} minutes`;
}

/** Live numbers for the progress screen and its polling. */
function progressOf(migration, steps) {
  const counts = migration.scan_counts || {};
  const estimate = estimates(migration, counts);

  const rows = steps.map((step) => {
    let total = Number(step.total) || 0;
    if (!total && step.phase !== "done" && step.status !== "done" && estimate[step.entity] !== undefined) {
      total = migration.type === "demo" ? Math.min(estimate[step.entity], C.DEMO_LIMIT) : estimate[step.entity];
    }
    const processed = Math.min(Number(step.processed) || 0, total || Number(step.processed) || 0);
    const phaseNote = step.status === "running"
      ? { export: `Reading your old store… ${Number(step.exported) || 0} read`, convert: "Preparing data…", import: step.bulk_operation_id ? "Shopify is creating these…" : "Creating in Shopify…" }[step.phase || "export"]
      : null;

    return {
      entity: step.entity,
      label: step.label,
      status: step.status,
      phase: step.phase,
      phaseNote,
      total,
      processed,
      succeeded: Number(step.succeeded) || 0,
      failed: Number(step.failed) || 0,
      skipped: Number(step.skipped) || 0,
      percent: step.status === "done" ? 100 : total ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    };
  });

  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const processed = rows.reduce((sum, row) => sum + row.processed, 0);
  const percent = total ? Math.min(100, Math.floor((processed / total) * 100)) : 0;

  let remaining = null;
  if (migration.status === "running" && migration.started_at && processed > 10 && processed < total) {
    const elapsed = (Date.now() - new Date(migration.started_at).getTime()) / 1000;
    remaining = Math.round(((total - processed) / processed) * elapsed);
  }

  return {
    id: migration.id,
    status: migration.status,
    phase: migration.phase,
    total,
    processed,
    percent,
    succeeded: rows.reduce((sum, row) => sum + row.succeeded, 0),
    failed: rows.reduce((sum, row) => sum + row.failed, 0),
    skipped: rows.reduce((sum, row) => sum + row.skipped, 0),
    remainingSeconds: remaining,
    lastError: migration.last_error,
    steps: rows,
  };
}

/* ------------------------------------------------------------------ */
/* list                                                                */
/* ------------------------------------------------------------------ */

exports.list = async (req, res) => {
  try {
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : "all";
    const [migrations, counts, connection] = await Promise.all([
      migrationModel.listForStore(req.storeId, { filter }),
      migrationModel.statusCounts(req.storeId),
      sourceConnectionModel.latestConnected(req.storeId),
    ]);

    res.render("migrations/list", {
      ...base(req),
      filter,
      counts,
      connection,
      migrations: migrations.map((m) => ({
        ...m,
        percent: m.step_total ? Math.min(100, Math.floor((m.step_processed / m.step_total) * 100)) : 0,
      })),
    });
  } catch (err) {
    console.error("Migrations list failed:", err.message);
    res.status(500).send("Error loading migrations");
  }
};

/* ------------------------------------------------------------------ */
/* new                                                                 */
/* ------------------------------------------------------------------ */

/** "New migration": a draft, opened at step 1. */
exports.create = async (req, res) => {
  try {
    const id = await migrationModel.createDraft(req.storeId, { options: { ...C.DEFAULT_OPTIONS } });
    return res.json({ ok: true, id, url: `/migrations/${id}` });
  } catch (err) {
    console.error("Creating a migration failed:", err.message);
    return jsonError(res, 500, "Could not start a new migration.");
  }
};

/**
 * "Run demo" from Setup. With a connected old store it queues a demo of
 * everything that store has, straight away; otherwise it opens the wizard.
 */
exports.quickDemo = async (req, res) => {
  try {
    const connection = await sourceConnectionModel.latestConnected(req.storeId);
    const options = { ...C.DEFAULT_OPTIONS };

    if (!connection) {
      const id = await migrationModel.createDraft(req.storeId, { type: "demo", options });
      return res.json({ ok: true, id, url: `/migrations/${id}` });
    }

    const platform = C.PLATFORM_BY_KEY[connection.platform];
    const entities = platform.entities.filter((entity) => entity === "redirects" || Number(connection.scan_counts[entity]) > 0);
    options.platform = connection.platform;

    const id = await migrationModel.createDraft(req.storeId, {
      connectionId: connection.id, type: "demo", wizardStep: 5, options, entities,
    });
    const migration = await migrationModel.findForStore(req.storeId, id);
    await begin(req, migration, "demo");
    return res.json({ ok: true, id, url: `/migrations/${id}` });
  } catch (err) {
    console.error("Quick demo failed:", err.message);
    return jsonError(res, err.statusCode || 500, err.statusCode ? err.message : "Could not start the demo.");
  }
};

/* ------------------------------------------------------------------ */
/* one migration: wizard / progress / results                          */
/* ------------------------------------------------------------------ */

exports.show = async (req, res) => {
  try {
    const migration = await load(req);
    if (!migration) return res.status(404).send("Migration not found");

    if (migration.status === "draft") return renderWizard(req, res, migration);

    const steps = await migrationModel.steps(migration.id);
    const progress = progressOf(migration, steps);

    if (migrationModel.ACTIVE.includes(migration.status)) {
      return res.render("migrations/progress", { ...base(req), migration, progress });
    }
    return renderResults(req, res, migration, progress);
  } catch (err) {
    console.error("Migration screen failed:", err.message);
    res.status(500).send("Error loading this migration");
  }
};

async function renderWizard(req, res, migration) {
  const requested = Number(req.query.step);
  const step = Number.isInteger(requested) && requested >= 1 && requested <= migration.wizard_step ? requested : migration.wizard_step;

  const platformKey = migration.options.platform || migration.platform || null;
  const platform = platformKey ? C.PLATFORM_BY_KEY[platformKey] : null;
  const [connection, limits] = await Promise.all([
    migration.source_connection_id ? sourceConnectionModel.findForStore(req.storeId, migration.source_connection_id) : null,
    planLimits.forStore(req.storeId),
  ]);
  const saved = platformKey && !connection ? await sourceConnectionModel.latestConnected(req.storeId, platformKey) : null;
  const counts = publicCounts(connection ? connection.scan_counts : {});

  const estimate = estimates(migration, counts);
  const total = totalOf(estimate, "full");
  const block = step === 5 ? planLimits.blockFor(limits, migration.entities, total) : null;

  res.render("migrations/wizard", {
    ...base(req),
    migration,
    step,
    platforms: C.PLATFORMS,
    platform,
    connection,
    saved,
    counts,
    entities: platform ? platform.entities.map((key) => C.BY_KEY[key]) : [],
    options: { ...C.DEFAULT_OPTIONS, ...migration.options },
    paymentStatuses: C.PAYMENT_STATUSES,
    fulfilmentStatuses: C.FULFILMENT_STATUSES,
    limits: { ...limits, remaining: limits.unlimited ? null : limits.remaining },
    allows: limits.allows,
    review: { estimate, total, eta: eta(total), block, demoTotal: totalOf(estimate, "demo") },
    demoLimit: C.DEMO_LIMIT,
  });
}

async function renderResults(req, res, migration, progress) {
  const [limits, errors, log] = await Promise.all([
    planLimits.forStore(req.storeId),
    migration.storage_path && !migration.files_deleted_at ? storage.readErrors(migration.storage_path) : [],
    migration.storage_path && !migration.files_deleted_at && req.query.log === "1" ? storage.readLog(migration.storage_path) : [],
  ]);

  const retryable = await unresolved(migration, errors);
  const started = migration.started_at ? new Date(migration.started_at) : null;
  const finished = migration.finished_at ? new Date(migration.finished_at) : null;

  res.render("migrations/results", {
    ...base(req),
    migration,
    progress,
    errors: errors.slice(0, 200),
    errorTotal: errors.length,
    retryable: retryable.total,
    durationSeconds: started && finished ? (finished - started) / 1000 : null,
    canDelta: limits.canDelta && ["full", "delta"].includes(migration.type) && migration.status === "completed",
    canDeltaPlan: limits.canDelta,
    cleanup: migration.options.demo_cleanup || null,
    log,
    retention: { personal: C.RETENTION_DAYS_PERSONAL, other: C.RETENTION_DAYS_OTHER },
  });
}

/** Failed records that a later run has not fixed yet: { total, byEntity }. */
async function unresolved(migration, errors) {
  const failed = errors.filter((row) => row.kind === "failed" && row.entity !== "redirects");
  const byEntity = {};
  for (const row of failed) (byEntity[row.entity] = byEntity[row.entity] || []).push(row.sourceId);

  let total = 0;
  for (const [entity, ids] of Object.entries(byEntity)) {
    const present = migration.source_connection_id ? await idMapModel.presentIds(migration.source_connection_id, entity, ids) : new Set();
    byEntity[entity] = ids.filter((id) => !present.has(String(id)));
    total += byEntity[entity].length;
    if (!byEntity[entity].length) delete byEntity[entity];
  }
  return { total, byEntity };
}

/* ------------------------------------------------------------------ */
/* wizard steps                                                        */
/* ------------------------------------------------------------------ */

exports.saveStep = async (req, res) => {
  try {
    const migration = await load(req);
    if (!migration) return jsonError(res, 404, "Migration not found.");
    if (migration.status !== "draft") return jsonError(res, 409, "This migration has already begun.");

    const step = Number(req.body.step);
    const body = req.body || {};

    if (step === 1) {
      const platform = C.PLATFORM_BY_KEY[body.platform];
      if (!platform || !platform.available) return jsonError(res, 400, "Choose a platform that is available.");

      const changed = migration.options.platform && migration.options.platform !== platform.key;
      const saved = await sourceConnectionModel.latestConnected(req.storeId, platform.key);
      const keepConnection = !changed && migration.source_connection_id && migration.platform === platform.key;

      await migrationModel.updateDraft(req.storeId, migration.id, {
        options: { ...migration.options, platform: platform.key },
        source_connection_id: keepConnection ? migration.source_connection_id : saved ? saved.id : null,
        entities: changed ? [] : migration.entities,
        wizard_step: changed ? 2 : Math.max(2, migration.wizard_step),
      });
      return res.json({ ok: true, next: 2 });
    }

    if (step === 2) {
      const connection = migration.source_connection_id
        ? await sourceConnectionModel.findForStore(req.storeId, migration.source_connection_id)
        : null;
      if (!connection || connection.status !== "connected" || connection.platform !== migration.options.platform) {
        return jsonError(res, 400, "Test the connection first — it has to succeed before you continue.");
      }

      // First time through: tick everything the old store has.
      let entities = migration.entities;
      if (!entities.length) {
        entities = C.PLATFORM_BY_KEY[connection.platform].entities.filter(
          (entity) => entity === "redirects" || Number(connection.scan_counts[entity]) > 0
        );
      }
      await migrationModel.updateDraft(req.storeId, migration.id, { entities, wizard_step: Math.max(3, migration.wizard_step) });
      return res.json({ ok: true, next: 3 });
    }

    if (step === 3) {
      const platform = C.PLATFORM_BY_KEY[migration.options.platform];
      if (!platform) return jsonError(res, 400, "Choose a platform first.");

      let entities = [].concat(body.entities || []).filter((entity) => platform.entities.includes(entity));
      // Orders link to their products and customers, so those come too.
      if (entities.includes("orders")) entities.push("products", "customers");
      entities = C.ENTITY_KEYS.filter((key) => entities.includes(key));
      if (!entities.filter((entity) => entity !== "redirects").length) {
        return jsonError(res, 400, "Choose at least one kind of data to migrate.");
      }

      const options = { ...migration.options };
      options.orders_range = body.orders_range === "range" ? "range" : "all";
      options.orders_from = DATE.test(body.orders_from || "") ? body.orders_from : null;
      options.orders_to = DATE.test(body.orders_to || "") ? body.orders_to : null;
      options.orders_count = null;

      if (entities.includes("orders") && options.orders_range === "range") {
        if (!options.orders_from) return jsonError(res, 400, "Choose the date the orders range starts from.");
        if (options.orders_to && options.orders_to < options.orders_from) {
          return jsonError(res, 400, "The end date is before the start date.");
        }
        try {
          const connection = await sourceConnectionModel.findWithCredentials(migration.source_connection_id);
          options.orders_count = await adapterFor(connection).countOrders({
            after: `${options.orders_from}T00:00:00`,
            before: options.orders_to ? `${options.orders_to}T23:59:59` : null,
          });
        } catch (err) {
          console.warn(`Counting orders in range failed for migration ${migration.id}: ${err.message}`);
        }
      }

      await migrationModel.updateDraft(req.storeId, migration.id, { entities, options, wizard_step: Math.max(4, migration.wizard_step) });
      return res.json({ ok: true, next: 4 });
    }

    if (step === 4) {
      const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
      const flag = (value) => value === true || value === "on" || value === "1" || value === "true";
      const options = {
        ...migration.options,
        product_status: pick(body.product_status, ["same", "draft"], "same"),
        sku_exists: pick(body.sku_exists, ["skip", "update"], "skip"),
        publish_online_store: flag(body.publish_online_store),
        extra_attributes: pick(body.extra_attributes, ["skip", "merge"], "skip"),
        email_exists: pick(body.email_exists, ["skip", "update"], "skip"),
        send_invites: flag(body.send_invites),
        keep_order_numbers: flag(body.keep_order_numbers),
        silent_orders: flag(body.silent_orders),
        page_status: pick(body.page_status, ["same", "hidden"], "same"),
        order_status_map: {},
      };
      const submitted = body.order_status_map || {};
      for (const [status, defaults] of Object.entries(C.DEFAULT_OPTIONS.order_status_map)) {
        const row = submitted[status] || {};
        options.order_status_map[status] = {
          payment: pick(row.payment, C.PAYMENT_STATUSES, defaults.payment),
          fulfilment: pick(row.fulfilment, C.FULFILMENT_STATUSES, defaults.fulfilment),
        };
      }

      await migrationModel.updateDraft(req.storeId, migration.id, { options, wizard_step: 5 });
      return res.json({ ok: true, next: 5 });
    }

    return jsonError(res, 400, "Unknown step.");
  } catch (err) {
    console.error("Saving wizard step failed:", err.message);
    return jsonError(res, 500, "Could not save this step.");
  }
};

/**
 * Step 2's "Test connection". Proves the keys work, counts what is there,
 * and saves the connection -- keys encrypted, never sent back.
 */
exports.testConnection = async (req, res) => {
  try {
    const migration = await load(req);
    if (!migration) return jsonError(res, 404, "Migration not found.");
    if (migration.status !== "draft") return jsonError(res, 409, "This migration has already begun.");

    const platform = migration.options.platform;
    const rules = CREDENTIALS[platform];
    if (!rules) return jsonError(res, 400, "Choose a platform first.");

    const baseUrl = await normalizeBaseUrl(req.body.base_url);

    // Re-testing a saved store with the key fields left empty reuses its keys.
    let credentials;
    const typed = rules.fields.some((field) => String(req.body[field] || "").trim());
    if (!typed) {
      const saved = await sourceConnectionModel.latestConnected(req.storeId, platform);
      if (saved && saved.base_url === baseUrl) {
        credentials = (await sourceConnectionModel.findWithCredentials(saved.id)).credentials;
      }
    }
    if (!credentials) credentials = rules.validate(req.body);

    let result;
    try {
      result = await adapterFor({ platform, base_url: baseUrl, credentials }).test();
    } catch (error) {
      if (!error.userFacing) throw error;
      return res.status(200).json({ ok: false, error: error.message });
    }

    const connection = await sourceConnectionModel.saveTest({
      storeId: req.storeId,
      platform,
      baseUrl,
      credentials,
      hint: rules.hint(credentials),
      ok: true,
      version: result.version,
      counts: { ...result.counts, _meta: result.meta || {} },
    });

    const changed = migration.source_connection_id !== connection.id;
    await migrationModel.updateDraft(req.storeId, migration.id, {
      source_connection_id: connection.id,
      entities: changed ? [] : migration.entities,
    });

    return res.json({
      ok: true,
      version: connection.source_version,
      hint: connection.credentials_hint,
      base_url: connection.base_url,
      counts: C.PLATFORM_BY_KEY[platform].entities
        .filter((entity) => entity !== "redirects")
        .map((entity) => ({ entity, label: C.BY_KEY[entity].source, count: Number(result.counts[entity]) || 0 })),
    });
  } catch (err) {
    if (err.userFacing) return res.status(200).json({ ok: false, error: err.message });
    console.error("Connection test failed:", err.message);
    return jsonError(res, 500, "Could not test the connection. Try again.");
  }
};

/* ------------------------------------------------------------------ */
/* begin                                                               */
/* ------------------------------------------------------------------ */

/** Check, then queue. Throws an error with statusCode for the merchant. */
async function begin(req, migration, type) {
  const fail = (message, status = 400, extra = {}) => {
    const error = new Error(message);
    error.statusCode = status;
    Object.assign(error, extra);
    throw error;
  };

  if (migration.status !== "draft") fail("This migration has already begun.", 409);
  const connection = migration.source_connection_id
    ? await sourceConnectionModel.findForStore(req.storeId, migration.source_connection_id)
    : null;
  if (!connection || connection.status !== "connected") fail("Connect your old store first.");
  if (!migration.entities.filter((entity) => entity !== "redirects").length) fail("Choose what to migrate first.");

  const estimate = estimates(migration, connection.scan_counts);
  const total = totalOf(estimate, type);

  if (type === "full") {
    const limits = await planLimits.forStore(req.storeId);
    const block = planLimits.blockFor(limits, migration.entities, total);
    if (block) fail(block, 402, { upgrade: true });
  }

  const storagePath = storage.storagePathFor(connection.platform, req.shop, migration.id);
  await storage.ensureDir(storagePath);

  const queued = await migrationModel.queue(req.storeId, migration.id, {
    type,
    totalRecords: total,
    storagePath,
    entities: migration.entities,
    options: { ...C.DEFAULT_OPTIONS, ...migration.options },
  });
  if (!queued) fail("This migration has already begun.", 409);

  await storage.log(storagePath, `Migration ${migration.id} queued (${type}, ${migration.entities.join(", ")}, about ${total} records)`);
}

exports.begin = async (req, res) => {
  try {
    const migration = await load(req);
    if (!migration) return jsonError(res, 404, "Migration not found.");
    const type = req.body.type === "demo" ? "demo" : "full";
    await begin(req, migration, type);
    return res.json({ ok: true, id: migration.id, url: `/migrations/${migration.id}` });
  } catch (err) {
    if (err.statusCode) return jsonError(res, err.statusCode, err.message, { upgrade: Boolean(err.upgrade) });
    console.error("Beginning migration failed:", err.message);
    return jsonError(res, 500, "Could not begin the migration.");
  }
};

exports.discard = async (req, res) => {
  try {
    const id = idParam(req);
    if (!id || !(await migrationModel.deleteDraft(req.storeId, id))) return jsonError(res, 404, "Draft not found.");
    return res.json({ ok: true });
  } catch (err) {
    console.error("Discarding draft failed:", err.message);
    return jsonError(res, 500, "Could not discard this draft.");
  }
};

/* ------------------------------------------------------------------ */
/* while it runs                                                       */
/* ------------------------------------------------------------------ */

exports.status = async (req, res) => {
  try {
    const migration = await load(req);
    if (!migration) return jsonError(res, 404, "Migration not found.");
    const steps = await migrationModel.steps(migration.id);
    return res.json({ ...progressOf(migration, steps), cleanup: migration.options.demo_cleanup || null });
  } catch (err) {
    console.error("Status check failed:", err.message);
    return jsonError(res, 500, "Could not read progress.");
  }
};

exports.control = async (req, res) => {
  try {
    const id = idParam(req);
    const action = String(req.body.action || "");
    if (!id || !["pause", "resume", "cancel"].includes(action)) return jsonError(res, 400, "Unknown action.");

    if (action === "cancel") {
      const migration = await migrationModel.findForStore(req.storeId, id);
      if (migration && migration.status !== "running") {
        // Nothing is working on it: set the retention dates now.
        const ok = await migrationModel.control(req.storeId, id, action);
        if (ok) {
          await migrationModel.finish(id, null, {
            status: "cancelled", personalDays: C.RETENTION_DAYS_PERSONAL, otherDays: C.RETENTION_DAYS_OTHER,
          });
        }
        return ok ? res.json({ ok: true }) : jsonError(res, 409, "This migration cannot be cancelled now.");
      }
    }

    const ok = await migrationModel.control(req.storeId, id, action);
    if (!ok) return jsonError(res, 409, `This migration cannot be ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"} now.`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Migration control failed:", err.message);
    return jsonError(res, 500, "Could not update the migration.");
  }
};

/* ------------------------------------------------------------------ */
/* after it ran                                                        */
/* ------------------------------------------------------------------ */

/** "Retry failed": a new run of only the records that failed. */
exports.retry = async (req, res) => {
  try {
    const parent = await load(req);
    if (!parent) return jsonError(res, 404, "Migration not found.");
    if (migrationModel.ACTIVE.includes(parent.status) || parent.status === "draft") {
      return jsonError(res, 409, "Wait for this migration to finish first.");
    }
    if (!parent.storage_path || parent.files_deleted_at) {
      return jsonError(res, 410, "This migration's files have been deleted, so its failures cannot be retried.");
    }

    const { total, byEntity } = await unresolved(parent, await storage.readErrors(parent.storage_path));
    if (!total) return jsonError(res, 400, "Nothing left to retry — every failed record has since been migrated.");

    const entities = C.ENTITY_KEYS.filter((key) => byEntity[key]);
    const options = { ...parent.options, include: byEntity };
    delete options.demo_cleanup;

    if (parent.type !== "demo") {
      const limits = await planLimits.forStore(req.storeId);
      const block = planLimits.blockFor(limits, entities, total);
      if (block) return jsonError(res, 402, block, { upgrade: true });
    }

    const id = await migrationModel.createDraft(req.storeId, {
      connectionId: parent.source_connection_id, type: "retry", wizardStep: 5, options, entities,
    });
    const storagePath = storage.storagePathFor(parent.platform, req.shop, id);
    await storage.ensureDir(storagePath);
    await migrationModel.queue(req.storeId, id, { type: "retry", totalRecords: total, storagePath, entities, options, parentId: parent.id });
    await storage.log(storagePath, `Retry of migration ${parent.id}: ${total} failed records`);

    return res.json({ ok: true, id, url: `/migrations/${id}` });
  } catch (err) {
    console.error("Retry failed:", err.message);
    return jsonError(res, 500, "Could not start the retry.");
  }
};

/** "Migrate recent data": only what is new or changed since this run. */
exports.delta = async (req, res) => {
  try {
    const parent = await load(req);
    if (!parent) return jsonError(res, 404, "Migration not found.");
    if (parent.status !== "completed" || !["full", "delta"].includes(parent.type)) {
      return jsonError(res, 409, "Recent data can follow a completed full migration.");
    }

    const limits = await planLimits.forStore(req.storeId);
    if (!limits.canDelta) return jsonError(res, 402, `Migrating recent data is not in your ${limits.name} plan.`, { upgrade: true });
    const block = planLimits.blockFor(limits, parent.entities, 0);
    if (block) return jsonError(res, 402, block, { upgrade: true });

    const entities = parent.entities;
    const options = { ...parent.options, modified_after: new Date(parent.started_at).toISOString().slice(0, 19) };
    delete options.include;
    delete options.demo_cleanup;

    const id = await migrationModel.createDraft(req.storeId, {
      connectionId: parent.source_connection_id, type: "delta", wizardStep: 5, options, entities,
    });
    const storagePath = storage.storagePathFor(parent.platform, req.shop, id);
    await storage.ensureDir(storagePath);
    await migrationModel.queue(req.storeId, id, { type: "delta", totalRecords: 0, storagePath, entities, options, parentId: parent.id });
    await storage.log(storagePath, `Recent data since migration ${parent.id} (${options.modified_after})`);

    return res.json({ ok: true, id, url: `/migrations/${id}` });
  } catch (err) {
    console.error("Delta failed:", err.message);
    return jsonError(res, 500, "Could not start migrating recent data.");
  }
};

/** "Delete demo data": remove what a demo created in Shopify. */
exports.deleteDemoData = async (req, res) => {
  try {
    const migration = await load(req);
    if (!migration) return jsonError(res, 404, "Migration not found.");
    if (migration.type !== "demo" || migrationModel.ACTIVE.includes(migration.status)) {
      return jsonError(res, 409, "Only a finished demo's data can be deleted here.");
    }
    if (migration.options.demo_cleanup && migration.options.demo_cleanup.status === "running") {
      return jsonError(res, 409, "The demo data is already being deleted.");
    }
    // Marked first, so the screen that reloads next already shows it running.
    await migrationModel.setOption(migration.id, "demo_cleanup", { status: "running", at: new Date().toISOString() });
    // Not awaited: it runs in the background and the screen polls /status.
    demoCleanup.run(req.store, migration);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Demo clean-up failed:", err.message);
    return jsonError(res, 500, "Could not delete the demo data.");
  }
};

/** "Delete migration data now": the folder goes immediately. */
exports.deleteFiles = async (req, res) => {
  try {
    const migration = await load(req);
    if (!migration) return jsonError(res, 404, "Migration not found.");
    if (migrationModel.ACTIVE.includes(migration.status)) return jsonError(res, 409, "Wait for this migration to finish first.");
    if (migration.storage_path) await storage.deleteFolder(migration.storage_path);
    await migrationModel.markFilesDeleted(migration.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Deleting migration files failed:", err.message);
    return jsonError(res, 500, "Could not delete the files.");
  }
};

/** errors.csv -- IDs, names of products/pages and reasons. No personal data. */
exports.errorsCsv = async (req, res) => {
  try {
    const migration = await load(req);
    if (!migration || !migration.storage_path || migration.files_deleted_at) return res.status(404).send("Not found");
    const csv = await storage.errorsCsv(migration.storage_path);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="migration-${migration.id}-errors.csv"`);
    return res.send("﻿" + csv);
  } catch (err) {
    console.error("Error CSV failed:", err.message);
    return res.status(500).send("Could not read the error report");
  }
};

exports.progressOf = progressOf;
exports.eta = eta;
exports.estimates = estimates;
