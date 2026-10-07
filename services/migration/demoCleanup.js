// services/migration/demoCleanup.js
//
// "Delete demo data": remove from Shopify everything a demo created, found
// through id_map's migration_id, then forget those id_map rows so a full
// migration creates the records again properly.
//
// It runs in the background (a demo is up to 20 of each type -- a minute or
// so of API calls) and reports on the migration's options.demo_cleanup, which
// the results screen polls.
const idMapModel = require("../../models/idMapModel");
const migrationModel = require("../../models/migrationModel");
const shopifyImport = require("./shopifyImport");

const inFlight = new Set();

async function run(store, migration) {
  if (inFlight.has(migration.id)) return;
  inFlight.add(migration.id);

  try {
    await migrationModel.setOption(migration.id, "demo_cleanup", { status: "running", at: new Date().toISOString() });

    // Orders before customers and products, products before collections.
    const rows = await idMapModel.listByMigration(migration.id);
    const removed = [];
    let failed = 0;

    for (const row of rows) {
      const gone = await shopifyImport.deleteRecord(store.shop_domain, row.entity, row.shopify_gid);
      if (gone) removed.push(row.id);
      else failed += 1;
    }

    await idMapModel.deleteRows(removed);
    await migrationModel.setOption(migration.id, "demo_cleanup", {
      status: failed ? "partial" : "done",
      removed: removed.filter((id) => rows.find((row) => row.id === id && row.entity !== "variant")).length,
      failed,
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Demo clean-up for migration ${migration.id} failed:`, error.message);
    await migrationModel.setOption(migration.id, "demo_cleanup", { status: "failed", error: "Could not reach Shopify. Try again.", at: new Date().toISOString() });
  } finally {
    inFlight.delete(migration.id);
  }
}

module.exports = { run };
