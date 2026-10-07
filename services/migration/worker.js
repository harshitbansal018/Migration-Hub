// services/migration/worker.js
//
// The background program that does the migrations, separate from the screens
// so a huge migration never makes the app slow for anyone else.
//
//   - Migrations wait in a queue (status = queued) and are served in turn.
//   - One migration at a time per shop; at most MIGRATION_MAX_CONCURRENT
//     across the whole server (2 by default).
//   - A run whose worker died (stale lock) is picked up again and carries on
//     from its saved position.
//   - Once an hour, files past their keep-until date are deleted.
//
// Started by `npm run worker` (worker.js at the project root). In
// development it can also run inside the web process -- see server.js.
const os = require("os");
const crypto = require("crypto");

const migrationModel = require("../../models/migrationModel");
const storage = require("./storage");
const runner = require("./runner");
const { MAX_CONCURRENT } = require("./constants");

const POLL_MS = Number(process.env.WORKER_POLL_MS || 3000);
const CLEANUP_MS = 60 * 60 * 1000;

function createWorker({ name = "worker" } = {}) {
  const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`.slice(0, 64);
  const signal = { stopping: false };
  const running = new Map(); // migration id -> promise
  let pollTimer = null;
  let cleanupTimer = null;
  let ticking = false;

  async function tick() {
    if (ticking || signal.stopping) return;
    ticking = true;
    try {
      // runningCount() is every worker's fresh locks, ours included, so the
      // server-wide limit holds however many workers there are.
      while (running.size < MAX_CONCURRENT && (await migrationModel.runningCount()) < MAX_CONCURRENT) {
        const claimed = await migrationModel.claimNext(workerId);
        if (!claimed) break;

        console.log(`[${name}] migration ${claimed.id} claimed (${claimed.type}, ${claimed.entities.join(", ")})`);
        const job = runner
          .run(claimed, { workerId, signal })
          .catch((error) => console.error(`[${name}] migration ${claimed.id} crashed:`, error))
          .finally(() => {
            running.delete(claimed.id);
            // Something else may be waiting behind it.
            setImmediate(tick);
          });
        running.set(claimed.id, job);
      }
    } catch (error) {
      console.error(`[${name}] queue check failed:`, error.message);
    } finally {
      ticking = false;
    }
  }

  /** Delete files whose keep-until date has passed. */
  async function cleanup() {
    try {
      for (const row of await migrationModel.personalFilesDue()) {
        await storage.deletePersonalFiles(row.storage_path);
        await migrationModel.markPersonalDeleted(row.id);
        console.log(`[${name}] migration ${row.id}: customer and order files deleted (retention)`);
      }
      for (const row of await migrationModel.foldersDue()) {
        await storage.deleteFolder(row.storage_path);
        await migrationModel.markFilesDeleted(row.id);
        console.log(`[${name}] migration ${row.id}: folder deleted (retention)`);
      }
    } catch (error) {
      console.error(`[${name}] retention clean-up failed:`, error.message);
    }
  }

  function start() {
    console.log(`[${name}] started as ${workerId} (max ${MAX_CONCURRENT} migrations at once)`);
    pollTimer = setInterval(tick, POLL_MS);
    cleanupTimer = setInterval(cleanup, CLEANUP_MS);
    tick();
    cleanup();
  }

  /** Finish the current page of every run, release the locks, then resolve. */
  async function stop() {
    signal.stopping = true;
    clearInterval(pollTimer);
    clearInterval(cleanupTimer);
    await Promise.allSettled([...running.values()]);
    console.log(`[${name}] stopped`);
  }

  return { start, stop, tick, cleanup, workerId };
}

module.exports = { createWorker };
