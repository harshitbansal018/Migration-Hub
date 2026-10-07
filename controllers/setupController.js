// controllers/setupController.js
//
// The screen a store lands on after install, and the app's home until setup
// is finished or skipped.
//
// Nothing about a step's progress is stored. Each step is ticked from the
// store's own data every time the screen is drawn:
//
//   1. Connect your old store   source_connections has a "connected" row
//   2. Run a free demo          migrations has a completed demo
//   3. Choose a plan            user_memberships has an active row
//
// The one thing written down is stores.onboarded_at: should the app still
// OPEN here. Finishing sets it, and so does Skip.
const storeModel = require("../models/storeModel");
const planModel = require("../models/planModel");
const sourceConnectionModel = require("../models/sourceConnectionModel");
const migrationModel = require("../models/migrationModel");
const { platformName, host } = require("../utils/viewHelpers");

const STEPS = [
  {
    key: "connect",
    title: "Connect your old store",
    body: "Give us read-only API keys for your WooCommerce or WordPress store. Nothing there is changed.",
    action: { label: "Connect store", kind: "new-migration" },
  },
  {
    key: "demo",
    title: "Run a free demo migration",
    body: "Move 20 of each so you can check how they look in Shopify.",
    action: { label: "Run demo", kind: "demo" },
    blockedBy: "connect",
  },
  {
    key: "plan",
    title: "Choose a plan",
    body: "Start on Free and change any time.",
    action: { label: "Go to Plans", href: "/plans" },
  },
];

/** Which steps this store has actually done, read from its own data. */
async function progress(store) {
  const [connection, demo, active, membership] = await Promise.all([
    sourceConnectionModel.latestConnected(store.id),
    migrationModel.hasCompletedDemo(store.id),
    migrationModel.activeForStore(store.id),
    planModel.activeMembership(store.id),
  ]);

  return {
    connect: Boolean(connection),
    demo,
    plan: Boolean(membership),
    detail: {
      connect: connection ? `Connected to ${platformName(connection.platform)} · ${host(connection.base_url)}` : null,
      demo: demo ? "Demo finished — check the records in your Shopify admin." : null,
      plan: membership ? `You are on the ${membership.name} plan.` : null,
    },
    // A demo that is running right now is "waiting", not "ready".
    waiting: { demo: active && active.type === "demo" ? active : null },
  };
}

function build(done) {
  const finished = new Set();

  return STEPS.map((step) => {
    const complete = Boolean(done[step.key]);
    if (complete) finished.add(step.key);

    let state = "ready";
    let note = null;
    if (complete) {
      state = "done";
    } else if (done.waiting && done.waiting[step.key]) {
      state = "waiting";
      note = `Demo is ${done.waiting[step.key].status}…`;
    } else if (step.blockedBy && !finished.has(step.blockedBy) && !done[step.blockedBy]) {
      state = "locked";
      note = `Available once “${STEPS.find((other) => other.key === step.blockedBy).title}” is done.`;
    }

    return {
      ...step,
      state,
      note,
      waitingId: done.waiting && done.waiting[step.key] ? done.waiting[step.key].id : null,
      detail: (done.detail && done.detail[step.key]) || null,
    };
  });
}

async function statusFor(store) {
  const steps = build(await progress(store));
  const done = steps.filter((step) => step.state === "done").length;

  return {
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
    next: steps.find((step) => step.state === "ready" || step.state === "waiting") || null,
  };
}

exports.getSetup = async (req, res) => {
  try {
    const status = await statusFor(req.store);
    if (status.complete) await storeModel.markOnboarded(req.store.id);

    res.render("setup", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      ...status,
    });
  } catch (err) {
    console.error("Setup screen failed:", err.message);
    res.status(500).send("Error loading setup");
  }
};

exports.postSkip = async (req, res) => {
  try {
    await storeModel.markOnboarded(req.store.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Skipping setup failed:", err.message);
    return res.status(500).json({ error: "Could not skip setup." });
  }
};

exports.STEPS = STEPS;
exports.statusFor = statusFor;
