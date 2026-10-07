// controllers/dashboardController.js
//
// The app's home once setup is finished or skipped. Every number is read
// from the database on each load:
//
//   Total / Completed / In progress / Failed   migrations, by status and type
//   Products, Customers, Orders, ...           migration_steps, per entity (demos excluded)
//   Total records migrated                     sum of succeeded (demos excluded)
//   Plan usage                                 this month's succeeded vs plans.max_records
//   Running banner                             the running migration and its current step
//   Recent migrations                          the last 5, with their connection
const migrationModel = require("../models/migrationModel");
const planLimits = require("../services/planLimits");
const setupController = require("./setupController");
const { progressOf } = require("./migrationController");

const CARDS = ["products", "customers", "orders", "collections", "redirects"];

exports.getDashboard = async (req, res) => {
  try {
    // Straight from install to setup, and here once it is finished or
    // skipped. Rendered in place: a redirect would drop the id_token.
    if (!req.store.onboarded_at) {
      return setupController.getSetup(req, res);
    }

    const [setup, counts, totals, limits, recent, active] = await Promise.all([
      setupController.statusFor(req.store),
      migrationModel.statusCounts(req.storeId),
      migrationModel.entityTotals(req.storeId),
      planLimits.forStore(req.storeId),
      migrationModel.listForStore(req.storeId, { limit: 6 }),
      migrationModel.activeForStore(req.storeId),
    ]);

    let live = null;
    if (active) {
      const progress = progressOf(active, await migrationModel.steps(active.id));
      const current = progress.steps.find((step) => step.status === "running") || progress.steps.find((step) => step.status === "pending");
      live = { migration: active, progress, current };
    }

    const succeeded = Object.entries(totals)
      .filter(([entity]) => entity !== "redirects")
      .reduce((sum, [, row]) => sum + row.succeeded, 0);
    const failed = Object.entries(totals)
      .filter(([entity]) => entity !== "redirects")
      .reduce((sum, [, row]) => sum + row.failed, 0);

    res.render("dashboard", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      setup: setup.complete ? null : setup,
      counts,
      cards: CARDS.map((entity) => ({ entity, ...(totals[entity] || { succeeded: 0, failed: 0, skipped: 0 }) })),
      succeeded,
      failed,
      successRate: succeeded + failed ? (succeeded / (succeeded + failed)) * 100 : null,
      limits,
      recent: recent.filter((m) => m.status !== "draft").slice(0, 5).map((m) => ({
        ...m,
        percent: m.step_total ? Math.min(100, Math.floor((m.step_processed / m.step_total) * 100)) : 0,
      })),
      live,
    });
  } catch (err) {
    console.error("Dashboard load failed:", err.message);
    res.status(500).send("Error loading dashboard");
  }
};
