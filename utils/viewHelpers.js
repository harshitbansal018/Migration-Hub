// utils/viewHelpers.js
//
// Small formatting helpers every template uses, registered on app.locals in
// server.js. One place decides how a number, a date or a status looks, so
// the dashboard and the list cannot drift apart.
const { BY_KEY, PLATFORM_BY_KEY } = require("../services/migration/constants");

const number = (value) => (Number(value) || 0).toLocaleString("en-US");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Today 14:02", "Yesterday", "4 Oct", "4 Oct 2025". UTC, like the server. */
function shortDate(value, { time = false } = {}) {
  const date = toDate(value);
  if (!date) return "—";
  const now = new Date();
  const day = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diffDays = Math.round((day(now) - day(date)) / 86400000);
  const hhmm = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;

  if (diffDays === 0) return time ? `Today ${hhmm}` : "Today";
  if (diffDays === 1) return time ? `Yesterday ${hhmm}` : "Yesterday";
  const base = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return date.getUTCFullYear() === now.getUTCFullYear() ? base : `${base} ${date.getUTCFullYear()}`;
}

/** "14 min ago", "2 days ago". */
function ago(value) {
  const date = toDate(value);
  if (!date) return "—";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "42 min", "1 h 5 min", "35 s". */
function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const STATUS = {
  draft: { label: "Draft", tone: "" },
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info", pulse: true },
  paused: { label: "Paused", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "critical" },
  cancelled: { label: "Cancelled", tone: "" },
};

const STEP_STATUS = {
  pending: { label: "Waiting", tone: "" },
  running: { label: "Running", tone: "info", pulse: true },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "critical" },
  skipped: { label: "Skipped", tone: "" },
};

const TYPE = { demo: "Demo", full: "Full", delta: "Recent data", retry: "Retry" };

function status(value) {
  return STATUS[value] || { label: value, tone: "" };
}

function stepStatus(value) {
  return STEP_STATUS[value] || { label: value, tone: "" };
}

function entityLabel(key) {
  return BY_KEY[key] ? BY_KEY[key].label : key;
}

/** "Products, Customers" — or "All" when everything was chosen. */
function entityList(keys, { all = null } = {}) {
  const list = (keys || []).filter((key) => key !== "redirects");
  if (all && list.length >= all) return "All";
  return list.map(entityLabel).join(", ") || "—";
}

function platformName(key) {
  return PLATFORM_BY_KEY[key] ? PLATFORM_BY_KEY[key].name : key || "—";
}

/** "myshop.com" from "https://myshop.com". */
function host(url) {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname.replace(/\/$/, "");
  } catch {
    return url || "—";
  }
}

const percent = (part, whole) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

module.exports = {
  number,
  shortDate,
  ago,
  duration,
  status,
  stepStatus,
  TYPE,
  entityLabel,
  entityList,
  platformName,
  host,
  percent,
};
