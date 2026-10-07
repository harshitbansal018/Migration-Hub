// services/migration/runner.js
//
// Runs ONE migration, start to finish, inside the worker.
//
// Data types go one at a time in the fixed order (collections -> products ->
// customers -> orders -> coupons -> pages -> posts -> redirects), and each
// goes through three phases:
//
//   EXPORT   old store -> export/*.part-N.jsonl.gz.enc, 50 records a request
//   CONVERT  export -> import/*.jsonl.enc in Shopify's format; problems go to
//            errors.csv. Runs right before its import, so an order is
//            converted AFTER its products and customer exist and can be linked.
//   IMPORT   import file -> Shopify. One by one for small jobs, a Shopify bulk
//            operation for big ones. Every success goes into id_map.
//
// Where it is (export_page, import_line, bulk_operation_id) and the counters
// are saved after every page, so a pause, a crash or a deploy costs at most
// one page -- and id_map stops that page creating anything twice.
//
// One bad record never stops a migration: it is written to errors.csv and the
// run carries on. Only an outage (old store down, Shopify unreachable, app
// uninstalled) stops it, as "failed", and Resume carries on from the same spot.
const crypto = require("crypto");

const storage = require("./storage");
const shopifyImport = require("./shopifyImport");
const bulk = require("./bulk");
const { adapterFor } = require("./sources");
const { converterFor } = require("./converters");
const C = require("./constants");
const migrationModel = require("../../models/migrationModel");
const idMapModel = require("../../models/idMapModel");
const sourceConnectionModel = require("../../models/sourceConnectionModel");
const storeModel = require("../../models/storeModel");
const mailer = require("../mailer");

/** Thrown to stop a run cleanly: paused, cancelled, shutting down, lock lost. */
class Stopped extends Error {
  constructor(reason) {
    super(`Stopped: ${reason}`);
    this.reason = reason;
  }
}

/** Which already-migrated records a data type needs to convert and link. */
const LOOKUPS = {
  collections: ["collections"],
  products: ["collections", "products", "variant"],
  customers: ["customers"],
  orders: ["orders", "customers", "variant"],
  coupons: ["coupons", "products"],
  pages: ["pages"],
  posts: ["posts"],
};

/** Only products can be updated in place by a "Migrate recent data" run. */
const UPDATABLE = new Set(["products"]);

const now = () => new Date();
const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

function redirectTarget(entity, handle) {
  if (!handle) return null;
  return {
    collections: `/collections/${handle}`,
    products: `/products/${handle}`,
    pages: `/pages/${handle}`,
    posts: `/blogs/${handle}`,
  }[entity] || null;
}

/**
 * Run a claimed migration.
 *
 *   signal.stopping   set by the worker on shutdown: stop after this page
 */
async function run(claimed, { workerId, signal = {} }) {
  const migration = claimed;
  const id = migration.id;
  const sp = migration.storage_path;

  const heartbeat = async () => {
    if (signal.stopping) throw new Stopped("shutdown");
    const status = await migrationModel.touch(id, workerId);
    if (status === null) throw new Stopped("lost-lock");
    if (status !== "running") throw new Stopped(status);
  };

  try {
    const store = await storeModel.findById(migration.store_id);
    if (!store || !store.is_active) throw new Error("The app is no longer installed on this Shopify store");

    const connection = await sourceConnectionModel.findWithCredentials(migration.source_connection_id);
    if (!connection) throw new Error("The connection to the old store was removed");

    await storage.ensureDir(sp);
    await storage.clearTmp(sp);
    await storage.log(sp, `Migration ${id} ${migration.phase === "export" && !migration.last_error ? "started" : "resumed"} (${migration.entities.join(", ")})`);

    const job = {
      id,
      migration,
      sp,
      store,
      shop: store.shop_domain,
      connection,
      options: { ...C.DEFAULT_OPTIONS, ...migration.options },
      adapter: adapterFor(connection, {
        onRetry: (error, wait, attempt) =>
          storage.log(sp, `Old store: ${error.message} Retrying in ${Math.round(wait / 1000)}s (attempt ${attempt})`),
      }),
      converter: converterFor(connection.platform),
      heartbeat,
      diskChecked: false,
    };

    for (const step of await migrationModel.steps(id)) {
      if (step.status === "done" || step.status === "skipped") continue;
      await heartbeat();
      await runStep(job, step);
    }

    await migrationModel.finish(id, workerId, {
      status: "completed",
      personalDays: C.RETENTION_DAYS_PERSONAL,
      otherDays: C.RETENTION_DAYS_OTHER,
    });

    const finished = await migrationModel.findById(id);
    await storage.log(sp, `Migration ${id} completed: ${finished.succeeded} migrated, ${finished.failed} failed, ${finished.skipped} skipped`);
    await mailer.migrationFinished(store, finished).catch((error) =>
      console.warn(`Completion email for migration ${id} failed: ${error.message}`)
    );
  } catch (error) {
    if (error instanceof Stopped) {
      if (error.reason === "lost-lock") return;
      if (error.reason === "cancelled") {
        await storage.log(sp, `Migration ${id} cancelled`);
        await migrationModel.finish(id, null, {
          status: "cancelled",
          personalDays: C.RETENTION_DAYS_PERSONAL,
          otherDays: C.RETENTION_DAYS_OTHER,
        });
        return;
      }
      await storage.log(sp, error.reason === "paused" ? `Migration ${id} paused` : `Worker stopping; migration ${id} will resume`);
      await migrationModel.release(id, workerId);
      return;
    }

    const message = publicMessage(error);
    console.error(`Migration ${id} failed:`, error.stack || error.message);
    await storage.log(sp, `Migration ${id} stopped: ${message}`);
    await migrationModel.fail(id, workerId, message);
  }
}

/** What the merchant is shown when a run stops. Never a stack trace. */
function publicMessage(error) {
  if (error.userFacing) return error.message;
  if (error.name === "ReauthRequiredError") return "Shopify access expired. Open the app from your Shopify admin to reconnect, then press Resume.";
  if (/disk space/i.test(error.message)) return error.message;
  if (error.response && error.response.status >= 500) return "Shopify is having problems right now. Press Resume to carry on.";
  if (!error.response && /ECONN|ETIMEDOUT|ENOTFOUND|socket/i.test(error.message)) return "Shopify could not be reached. Press Resume to carry on.";
  return error.message && error.message.length < 200 ? error.message : "Something went wrong. Press Resume to carry on from where it stopped.";
}

async function runStep(job, step) {
  await migrationModel.updateStep(step.id, { status: "running", started_at: step.started_at || now() });

  if (step.entity === "redirects") {
    await migrationModel.setPhase(job.id, "import");
    await runRedirects(job, step);
  } else {
    let phase = step.phase || "export";
    if (phase === "export") {
      await exportStep(job, step);
      phase = "convert";
    }
    if (phase === "convert") {
      await convertStep(job, step);
      phase = "import";
    }
    if (phase === "import") await importStep(job, step);
  }

  await migrationModel.updateStep(step.id, { status: "done", phase: "done", finished_at: now() });
}

/* ------------------------------------------------------------------ */
/* EXPORT                                                              */
/* ------------------------------------------------------------------ */

async function exportStep(job, step) {
  const { migration, options, sp, adapter } = job;
  const entity = step.entity;

  if (!job.diskChecked) {
    await storage.assertFreeDisk();
    job.diskChecked = true;
  }
  await migrationModel.setPhase(job.id, "export");
  await migrationModel.updateStep(step.id, { phase: "export" });

  const demo = migration.type === "demo";
  const perPage = demo ? C.DEMO_LIMIT : C.PAGE_SIZE;
  const include = migration.type === "retry" ? ((options.include || {})[entity] || []) : null;
  const filters = {
    modifiedAfter: migration.type === "delta" ? options.modified_after : null,
    after: entity === "orders" && options.orders_range === "range" && options.orders_from ? `${options.orders_from}T00:00:00` : null,
    before: entity === "orders" && options.orders_range === "range" && options.orders_to ? `${options.orders_to}T23:59:59` : null,
  };

  if (include && !include.length) {
    await migrationModel.updateStep(step.id, { phase: "convert", total: 0 });
    return;
  }

  let page = Number(step.export_page) || 0;
  let exported = Number(step.exported) || 0;
  let total = Number(step.total) || 0;
  let done = false;

  if (page === 0) await storage.log(job.sp, `Export ${entity}: reading the old store`);

  while (!done) {
    const partStart = page + 1;
    const writer = await storage.openWriter(
      require("path").join(storage.resolveDir(sp), storage.exportPartName(entity, partStart)),
      { gzip: true }
    );

    try {
      for (let pages = 0; pages < C.PART_PAGES && !done; pages += 1) {
        const request = { page: page + 1, perPage, ...filters };
        if (include) {
          request.include = include.slice(page * perPage, (page + 1) * perPage);
          request.page = 1;
        }

        const result = await adapter.fetchPage(entity, request);
        for (const record of result.records) await writer.write(record);
        page += 1;

        if (!total) {
          total = include ? include.length : demo ? Math.min(result.total || result.records.length, C.DEMO_LIMIT) : result.total;
          await migrationModel.updateStep(step.id, { total });
        }

        done =
          demo ||
          result.records.length < perPage ||
          (include ? page * perPage >= include.length : result.totalPages > 0 && page >= result.totalPages);
      }
      await writer.close();
    } catch (error) {
      await writer.abort();
      throw error;
    }

    exported += writer.count;
    // Saved only once the part is safely on disk: after a crash the export
    // resumes from the last finished part, never from a half-written one.
    await migrationModel.updateStep(step.id, { export_page: page, exported });
    await job.heartbeat();
  }

  await migrationModel.updateStep(step.id, { total: exported, phase: "convert" });
  await storage.log(sp, `Export ${entity}: ${exported} read`);
}

/* ------------------------------------------------------------------ */
/* CONVERT                                                             */
/* ------------------------------------------------------------------ */

async function convertStep(job, step) {
  const { migration, options, sp, connection, converter, shop } = job;
  const entity = step.entity;
  const convert = converter.convert[entity];
  if (!convert) throw new Error(`${connection.platform} cannot migrate ${entity}`);

  await migrationModel.setPhase(job.id, "convert");
  await migrationModel.updateStep(step.id, { phase: "convert" });

  const ctx = {
    options,
    currency: job.store.currency,
    weightUnit: (connection.scan_counts && connection.scan_counts._meta && connection.scan_counts._meta.weightUnit) || "kg",
    idMap: await idMapModel.loadMap(connection.id, LOOKUPS[entity] || [entity]),
  };

  if (entity === "products") ctx.locationId = await shopifyImport.primaryLocationId(shop);
  if (entity === "posts") ctx.blog = await shopifyImport.ensureBlog(shop);
  if (converter.prepare[entity]) {
    const all = [];
    for await (const record of storage.readExport(sp, entity)) all.push(record);
    Object.assign(ctx, converter.prepare[entity](all));
  }

  const file = require("path").join(storage.resolveDir(sp), storage.importFileName(entity));
  const out = await storage.openWriter(file);
  let failed = 0;
  let skipped = 0;

  const note = async (line, kind, reason, name) => {
    await storage.appendError(sp, { entity, sourceId: line, name, kind, reason });
    if (kind === "failed") failed += 1;
    else skipped += 1;
  };

  /** Lines wait here in batches so their SKUs can be checked in one query. */
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;

    if (entity === "products") {
      const skus = batch.filter((line) => !line.updateGid).flatMap((line) => line.skus || []);
      const taken = skus.length ? await shopifyImport.findSkus(shop, skus) : new Map();
      for (const line of batch) {
        const clash = !line.updateGid && (line.skus || []).find((sku) => taken.has(sku));
        if (!clash) continue;
        if (options.sku_exists === "update") {
          line.updateGid = taken.get(clash).gid;
          line.variables.input.id = line.updateGid;
        } else {
          line.skipped = `SKU ${clash} already exists in Shopify`;
        }
      }
    }

    for (const line of batch) {
      if (line.skipped) {
        await note(line.sourceId, "skipped", line.skipped, line.name);
        continue;
      }
      delete line.skus;
      await out.write(line);
    }
    batch = [];
  };

  try {
    for await (const record of storage.readExport(sp, entity)) {
      let result;
      try {
        result = convert(record, ctx);
      } catch (error) {
        result = { fail: `Could not be converted: ${error.message}` };
      }

      const sourceId = String(record.id);
      const label = ["customers", "orders"].includes(entity) ? `${C.BY_KEY[entity].label.replace(/s$/, "")} #${record.number || record.id}` : record.name || (record.title && record.title.rendered) || record.code || sourceId;

      if (result.fail) {
        await note(sourceId, "failed", result.fail, label);
        continue;
      }
      if (result.skip) {
        await note(sourceId, "skipped", result.skip, label);
        continue;
      }

      const line = result.line;
      const existing = ctx.idMap.get(entity, line.sourceId);
      if (existing) {
        if (migration.type === "delta" && UPDATABLE.has(entity) && existing.hash !== line.hash) {
          // Changed since it was migrated: update the Shopify product in place.
          line.updateGid = existing.gid;
          line.variables.input.id = existing.gid;
        } else {
          // Already in Shopify -- no duplicates. Counted, not reported.
          skipped += 1;
          continue;
        }
      }

      batch.push(line);
      if (batch.length >= C.PAGE_SIZE) await flush();
    }
    await flush();
    await out.close();
  } catch (error) {
    await out.abort();
    throw error;
  }

  await migrationModel.updateStep(step.id, {
    phase: "import",
    failed,
    skipped,
    processed: failed + skipped,
    succeeded: 0,
    imported: 0,
    import_line: 0,
  });
  step.failed = failed;
  step.skipped = skipped;
  step.processed = failed + skipped;
  step.import_line = 0;
  await storage.log(sp, `Convert ${entity}: ${out.count} ready, ${failed} failed, ${skipped} skipped`);
}

/* ------------------------------------------------------------------ */
/* IMPORT                                                              */
/* ------------------------------------------------------------------ */

async function importStep(job, step) {
  const { migration, sp } = job;
  const entity = step.entity;
  await migrationModel.setPhase(job.id, "import");
  await migrationModel.updateStep(step.id, { phase: "import" });

  const file = require("path").join(storage.resolveDir(sp), storage.importFileName(entity));
  let lines = 0;
  for await (const _ of storage.readLines(file)) lines += 1; // eslint-disable-line no-unused-vars

  const definition = shopifyImport.MUTATIONS[entity];
  const ctx = {
    idMap: await idMapModel.loadMap(job.connection.id, [entity]),
    publicationId:
      job.options.publish_online_store && ["products", "collections"].includes(entity)
        ? await shopifyImport.onlineStorePublicationId(job.shop)
        : null,
  };

  const useBulk = definition.bulk && migration.type !== "demo" && lines - step.import_line >= C.BULK_THRESHOLD;
  await storage.log(sp, `Import ${entity}: ${lines} to create${useBulk ? " (Shopify bulk operation)" : ""}`);

  if (useBulk) await importBulk(job, step, file, ctx);
  else await importOneByOne(job, step, file, ctx);
}

/** Counters waiting to be saved; written once a page, not once a record. */
function tally() {
  return { succeeded: 0, failed: 0, skipped: 0, processed: 0 };
}

async function saveTally(step, counts, extra = {}) {
  await migrationModel.updateStep(step.id, {
    succeeded: { raw: `succeeded + ${Number(counts.succeeded)}` },
    imported: { raw: `imported + ${Number(counts.succeeded)}` },
    failed: { raw: `failed + ${Number(counts.failed)}` },
    skipped: { raw: `skipped + ${Number(counts.skipped)}` },
    processed: { raw: `processed + ${Number(counts.processed)}` },
    ...extra,
  });
  Object.assign(counts, tally());
}

/** What a created record leaves behind: its id_map rows, and any follow-ups. */
async function recordSuccess(job, entity, line, created, ctx, { followUps = true } = {}) {
  const rows = [
    {
      storeId: job.store.id,
      connectionId: job.connection.id,
      entity,
      sourceId: line.sourceId,
      sourceUrl: line.sourceUrl || null,
      gid: created.gid,
      handle: created.handle || line.handle || null,
      hash: line.hash || null,
      migrationId: job.id,
    },
    ...(created.children || []).map((child) => ({
      storeId: job.store.id,
      connectionId: job.connection.id,
      entity: child.entity,
      sourceId: child.sourceId,
      gid: child.gid,
      migrationId: job.id,
    })),
  ];
  await idMapModel.save(rows);
  ctx.idMap.set(entity, line.sourceId, { gid: created.gid, migrationId: job.id });

  if (!followUps) return;
  if (ctx.publicationId && !line.updateGid) await shopifyImport.publish(job.shop, created.gid, ctx.publicationId);
  if (entity === "customers" && job.options.send_invites && job.migration.type !== "demo") {
    await shopifyImport.sendInvite(job.shop, created.gid);
  }
}

/**
 * A record Shopify refused. Customers whose email is already in Shopify are
 * linked to that customer (so their orders still find them) and, if chosen,
 * updated. Returns the outcome: succeeded / skipped / failed.
 */
async function recordFailure(job, entity, line, errors, ctx) {
  const reason = errors.join("; ").slice(0, 1000);

  if (entity === "customers" && line.email && /(email|e-mail).*(taken|already)/i.test(reason)) {
    const existing = await shopifyImport.findCustomerByEmail(job.shop, line.email);
    if (existing) {
      await recordSuccess(job, entity, line, { gid: existing }, ctx, { followUps: false });
      if (job.options.email_exists === "update") {
        const problems = await shopifyImport.updateCustomer(job.shop, existing, line.variables.input);
        if (!problems.length) return "succeeded";
      }
      await storage.appendError(job.sp, {
        entity, sourceId: line.sourceId, name: line.name, kind: "skipped",
        reason: "Email already exists in Shopify — linked to that customer",
      });
      return "skipped";
    }
  }

  if (entity === "redirects" && /taken|already exists/i.test(reason)) {
    return "skipped";
  }

  await storage.appendError(job.sp, { entity, sourceId: line.sourceId, name: line.name, kind: "failed", reason });
  return "failed";
}

async function importOneByOne(job, step, file, ctx) {
  const entity = step.entity;
  const counts = tally();
  let current = Number(step.import_line) || 0;

  for await (const { line: number, record: line } of storage.readLines(file)) {
    if (number <= current) continue;

    let outcome;
    const existing = ctx.idMap.get(entity, line.sourceId);

    if (existing && !line.updateGid) {
      // Created before a restart, but not yet counted: count it now.
      outcome = existing.migrationId === job.id ? "succeeded" : "skipped";
    } else {
      let result = await shopifyImport.createOne(job.shop, entity, line);

      // A handle clash is not worth failing a record over: let Shopify pick.
      if (!result.gid && result.errors.some((error) => /handle/i.test(error) && /taken|use|exists/i.test(error))) {
        const key = Object.keys(line.variables).find((name) => line.variables[name] && line.variables[name].handle);
        if (key) {
          delete line.variables[key].handle;
          result = await shopifyImport.createOne(job.shop, entity, line);
        }
      }

      if (result.gid) {
        await recordSuccess(job, entity, line, result, ctx);
        outcome = "succeeded";
      } else {
        outcome = await recordFailure(job, entity, line, result.errors, ctx);
      }
    }

    counts[outcome] += 1;
    counts.processed += 1;
    current = number;

    if (counts.processed >= C.PAGE_SIZE) {
      await saveTally(step, counts, { import_line: current });
      await job.heartbeat();
    }
  }

  await saveTally(step, counts, { import_line: current });
}

/**
 * Big jobs: hand Shopify a file of up to ~15 MB at a time and let it do the
 * creating.
 *
 * Crash safety. Before an operation starts, the exact import lines it is
 * given are written to a sidecar file (import/<entity>.bulk.json); the
 * operation id is added once Shopify accepts it. A worker that restarts
 * finds the sidecar and waits for -- and reads the results of -- exactly
 * that operation with exactly those lines, instead of starting another one
 * and creating everything twice. Counters and import_line are saved, and the
 * sidecar removed, only after every result is recorded in id_map.
 */
async function importBulk(job, step, file, ctx) {
  const entity = step.entity;
  const definition = shopifyImport.MUTATIONS[entity];
  const sidecar = require("path").join(storage.resolveDir(job.sp), `import/${entity}.bulk.json`);
  let start = Number(step.import_line) || 0;

  for (;;) {
    const pending = readSidecar(sidecar);

    const chunk = [];
    let bytes = 0;
    for await (const { line: number, record } of storage.readLines(file)) {
      if (number <= start) continue;
      const text = JSON.stringify(record.variables);
      if (chunk.length && bytes + text.length + 1 > bulk.MAX_UPLOAD_BYTES) break;
      const existing = ctx.idMap.get(entity, record.sourceId);
      chunk.push({ number, line: record, text, existing: existing && !record.updateGid ? existing : null });
      bytes += text.length + 1;
    }
    if (!chunk.length) break;

    // Resuming: exactly the lines the running operation was given.
    // Otherwise: everything not already in Shopify.
    const send = pending
      ? chunk.filter((item) => pending.lines.includes(item.number))
      : chunk.filter((item) => !item.existing);
    const sent = new Set(send.map((item) => item.number));

    const counts = tally();
    for (const item of chunk.filter((entry) => !sent.has(entry.number))) {
      counts[item.existing && item.existing.migrationId === job.id ? "succeeded" : "skipped"] += 1;
      counts.processed += 1;
    }

    let created = [];
    if (send.length) {
      let operationId = pending && pending.operationId;

      if (!operationId) {
        // A sidecar with no operation id: the worker died between asking
        // Shopify to start and hearing back. Adopt that operation if it exists.
        const at = pending ? pending.at : new Date().toISOString();
        if (!pending) writeSidecar(sidecar, { lines: [...sent], at });
        operationId = pending ? await bulk.adoptRecent(job.shop, at) : null;
        if (!operationId) {
          const path = await bulk.upload(job.shop, send.map((item) => item.text).join("\n"));
          operationId = await bulk.start(job.shop, definition.query, path);
        }
        writeSidecar(sidecar, { lines: [...sent], at, operationId });
        await migrationModel.updateStep(step.id, { bulk_operation_id: operationId });
        await storage.log(job.sp, `Import ${entity}: Shopify bulk operation started for ${send.length} records`);
      }

      let stopped = null;
      const before = Number(step.processed) || 0;
      const operation = await bulk.waitFor(job.shop, operationId, async (progress) => {
        try {
          await job.heartbeat();
        } catch (error) {
          stopped = error;
          return "stop";
        }
        // Shopify's own counter, so the bar moves while Shopify works.
        await migrationModel.updateStep(step.id, {
          processed: before + counts.processed + Math.min(Number(progress.objectCount) || 0, send.length),
        });
        return null;
      });
      if (stopped) throw stopped;

      const resultsUrl = operation.url || operation.partialDataUrl;
      if (operation.status !== "COMPLETED" && !resultsUrl) {
        // Nothing was created: forget the operation, so Resume starts afresh.
        removeSidecar(sidecar);
        await migrationModel.updateStep(step.id, { bulk_operation_id: null, processed: before });
        throw new Error(`Shopify's bulk import ${operation.status.toLowerCase()}${operation.errorCode ? ` (${operation.errorCode})` : ""}`);
      }

      const seen = new Set();
      for await (const result of bulk.results(resultsUrl)) {
        const item = send[result.__lineNumber];
        if (!item) continue;
        seen.add(result.__lineNumber);

        const outcome = result.errors
          ? { errors: result.errors.map((error) => error.message) }
          : shopifyImport.interpret(entity, item.line, result.data && result.data[definition.root]);

        if (outcome.gid) {
          await recordSuccess(job, entity, item.line, outcome, ctx, { followUps: false });
          created.push({ gid: outcome.gid, line: item.line });
          counts.succeeded += 1;
        } else {
          counts[await recordFailure(job, entity, item.line, outcome.errors, ctx)] += 1;
        }
        counts.processed += 1;
      }

      for (let index = 0; index < send.length; index += 1) {
        if (seen.has(index)) continue;
        const reason = operation.status === "COMPLETED"
          ? "Shopify returned no result for this record"
          : `Shopify's bulk import stopped early (${operation.errorCode || operation.status})`;
        counts[await recordFailure(job, entity, send[index].line, [reason], ctx)] += 1;
        counts.processed += 1;
      }
    }

    start = chunk[chunk.length - 1].number;
    // Absolute: the progress written while Shopify worked was an estimate.
    await migrationModel.updateStep(step.id, { processed: Number(step.processed) || 0 });
    await saveTally(step, counts, { import_line: start, bulk_operation_id: null });
    removeSidecar(sidecar);
    const [fresh] = (await migrationModel.steps(job.id)).filter((row) => row.id === step.id);
    Object.assign(step, fresh);

    // After the counts are safe: a failure here must not repeat the import.
    await followUpsAfterBulk(job, entity, created, ctx);
    created = [];
    await job.heartbeat();
  }
}

function readSidecar(file) {
  try {
    return JSON.parse(require("fs").readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeSidecar(file, value) {
  const fs = require("fs");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

function removeSidecar(file) {
  require("fs").rmSync(file, { force: true });
}

/**
 * Publishing and invites for records a bulk operation created. Never fatal:
 * the records exist; a product that did not get published can be published
 * from the Shopify admin.
 */
async function followUpsAfterBulk(job, entity, created, ctx) {
  if (!created.length) return;

  try {
    if (ctx.publicationId) {
      const fresh = created.filter((item) => !item.line.updateGid);
      if (fresh.length >= C.BULK_THRESHOLD) {
        // Publishing thousands one by one would take hours: one more bulk op.
        const mutation = `mutation Publish($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) { userErrors { message } }
        }`;
        const text = fresh.map((item) => JSON.stringify({ id: item.gid, input: [{ publicationId: ctx.publicationId }] })).join("\n");
        const id = await bulk.start(job.shop, mutation, await bulk.upload(job.shop, text));
        await bulk.waitFor(job.shop, id, async () => {
          await job.heartbeat();
          return null;
        });
        await storage.log(job.sp, `Published ${fresh.length} ${entity} to the Online Store`);
      } else {
        for (const item of fresh) await shopifyImport.publish(job.shop, item.gid, ctx.publicationId);
      }
    }

    if (entity === "customers" && job.options.send_invites) {
      for (const item of created) await shopifyImport.sendInvite(job.shop, item.gid);
    }
  } catch (error) {
    if (error instanceof Stopped) throw error;
    await storage.log(job.sp, `Follow-up for ${entity} incomplete (${error.message}); the records themselves were created`);
  }
}

/* ------------------------------------------------------------------ */
/* REDIRECTS                                                           */
/* ------------------------------------------------------------------ */

async function runRedirects(job, step) {
  const all = await idMapModel.redirectSources(job.connection.id);
  // A demo creates redirects only for what the demo itself moved.
  const sources = job.migration.type === "demo" ? all.filter((row) => row.migration_id === job.id) : all;

  await migrationModel.updateStep(step.id, { total: sources.length, phase: "import" });
  await storage.log(job.sp, `Redirects: ${sources.length} old addresses to point at Shopify`);

  const ctx = { idMap: await idMapModel.loadMap(job.connection.id, ["redirects"]) };
  const counts = tally();
  let current = Number(step.import_line) || 0;

  for (let index = current; index < sources.length; index += 1) {
    const row = sources[index];
    const path = row.source_url;
    const target = redirectTarget(row.entity, row.shopify_handle);
    const sourceId = sha1(path);
    const line = { sourceId, name: path, sourceUrl: path, variables: { urlRedirect: { path, target } } };

    let outcome;
    if (!target || path === target || path.replace(/\/$/, "") === target) {
      outcome = "skipped";
    } else if (ctx.idMap.get("redirects", sourceId)) {
      outcome = "skipped";
    } else {
      const result = await shopifyImport.createOne(job.shop, "redirects", line);
      if (result.gid) {
        await recordSuccess(job, "redirects", line, { gid: result.gid, handle: target }, ctx, { followUps: false });
        outcome = "succeeded";
      } else {
        outcome = await recordFailure(job, "redirects", line, result.errors, ctx);
      }
    }

    counts[outcome] += 1;
    counts.processed += 1;
    current = index + 1;
    if (counts.processed >= C.PAGE_SIZE) {
      await saveTally(step, counts, { import_line: current });
      await job.heartbeat();
    }
  }
  await saveTally(step, counts, { import_line: current });
}

module.exports = { run, Stopped, redirectTarget, publicMessage };
