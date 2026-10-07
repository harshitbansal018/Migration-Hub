// worker.js -- the migration worker, as its own program.
//
//   npm run worker
//
// Run one (or more, on more servers) alongside the web app in production.
// Ctrl+C / SIGTERM finishes the current page of each migration and releases
// it, so a deploy never loses work: the next worker carries on from there.
require("dotenv").config();

const { assertConnection } = require("./config/db");
const { runMigrations } = require("./config/migrate");
const { createWorker } = require("./services/migration/worker");

(async () => {
  try {
    await assertConnection();
    await runMigrations();
  } catch (err) {
    console.error("Worker startup failed:", err.message);
    process.exit(1);
  }

  const worker = createWorker({ name: "worker" });
  worker.start();

  let stopping = false;
  const shutdown = async (signalName) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signalName} received: finishing the current page, then stopping`);
    await worker.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
})();
