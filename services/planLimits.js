// services/planLimits.js
//
// What the store's plan allows right now. Read from the plan's own columns
// (max_records, allowed_entities), so the plan card and what is enforced
// cannot say different things.
//
// The free demo is never limited and never counted.
const planModel = require("../models/planModel");
const migrationModel = require("../models/migrationModel");
const { parseJson } = require("../models/helpers");

async function forStore(storeId) {
  const [current, used] = await Promise.all([planModel.effectivePlan(storeId), migrationModel.monthUsage(storeId)]);
  const plan = current.plan || null;

  const maxRecords = plan && plan.max_records !== null && plan.max_records !== undefined ? Number(plan.max_records) : null;
  const allowed = plan ? parseJson(plan.allowed_entities, null) : null;
  const unlimited = maxRecords === null;

  const now = new Date();
  const resetsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return {
    plan,
    chosen: current.chosen,
    name: plan ? plan.name : "Free",
    maxRecords,
    unlimited,
    used,
    remaining: unlimited ? Infinity : Math.max(0, maxRecords - used),
    demoOnly: maxRecords === 0,
    allowed,
    allows: (entity) => !allowed || allowed.includes(entity),
    canDelta: !allowed || allowed.includes("delta"),
    resetsOn,
  };
}

/**
 * Can a full run of `total` records of these data types begin?
 * Returns null when it can, or the reason it cannot.
 */
function blockFor(limits, entities, total) {
  if (limits.demoOnly) return `The ${limits.name} plan includes the free demo only. Choose a plan to run a full migration.`;
  const notAllowed = entities.filter((entity) => !limits.allows(entity));
  if (notAllowed.length) return `Your ${limits.name} plan does not include ${notAllowed.join(", ")}.`;
  if (!limits.unlimited && total > limits.remaining) {
    return `This migration has ${total.toLocaleString("en-US")} records but your ${limits.name} plan has ${limits.remaining.toLocaleString("en-US")} left this month.`;
  }
  return null;
}

module.exports = { forStore, blockFor };
