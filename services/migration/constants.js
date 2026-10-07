// services/migration/constants.js
//
// The vocabulary every part of a migration shares: which data types exist,
// the order they move in, what each platform can supply, and the knobs that
// keep the load low. Screens, the wizard, the worker and the dashboard all
// read from here so they cannot disagree about what "orders" means.

/**
 * Every data type, in the order it moves. Later data links to earlier data
 * (an order points at its products and customer), so this order is fixed.
 *
 *   label      what the merchant reads
 *   shopify    what it becomes in Shopify
 *   personal   holds personal data: its files are kept 30 days, not 90
 *   needs      other types that must move first for this one to link up
 */
const ENTITIES = [
  { key: "collections", label: "Collections", source: "Categories", shopify: "Collections", position: 1 },
  { key: "products", label: "Products", source: "Products", shopify: "Products", detail: "variants, images, stock", position: 2 },
  { key: "customers", label: "Customers", source: "Customers", shopify: "Customers", personal: true, position: 3 },
  { key: "orders", label: "Orders", source: "Orders", shopify: "Orders", personal: true, needs: ["products", "customers"], position: 4 },
  { key: "coupons", label: "Coupons", source: "Coupons", shopify: "Discount codes", position: 5 },
  { key: "pages", label: "Pages", source: "Pages", shopify: "Pages", position: 6 },
  { key: "posts", label: "Blog posts", source: "Blog posts", shopify: "Blog posts", position: 7 },
  { key: "redirects", label: "Redirects", source: "301 Redirects", shopify: "URL redirects", detail: "keep Google rankings", position: 8 },
];

const ENTITY_KEYS = ENTITIES.map((entity) => entity.key);
const BY_KEY = Object.fromEntries(ENTITIES.map((entity) => [entity.key, entity]));

/**
 * The platforms on the wizard's first step. `entities` is what that
 * platform can supply; redirects come for free wherever there are URLs.
 */
const PLATFORMS = [
  {
    key: "woocommerce",
    name: "WooCommerce",
    blurb: "Products, customers, orders",
    available: true,
    entities: ["collections", "products", "customers", "orders", "coupons", "pages", "posts", "redirects"],
  },
  {
    key: "wordpress",
    name: "WordPress",
    blurb: "Pages, blog posts",
    available: true,
    entities: ["pages", "posts", "redirects"],
  },
  { key: "csv", name: "CSV file", blurb: "Any platform", available: false, entities: [] },
  { key: "magento", name: "Magento", blurb: "Coming soon", available: false, entities: [] },
  { key: "bigcommerce", name: "BigCommerce", blurb: "Coming soon", available: false, entities: [] },
];

const PLATFORM_BY_KEY = Object.fromEntries(PLATFORMS.map((platform) => [platform.key, platform]));

/** Defaults for the wizard's Options step. Saved to migrations.options. */
const DEFAULT_OPTIONS = {
  product_status: "same", // same | draft
  sku_exists: "skip", // skip | update
  publish_online_store: true,
  extra_attributes: "skip", // skip (and report) | merge
  email_exists: "skip", // skip | update
  send_invites: false,
  keep_order_numbers: false,
  // Old orders are history: emailing customers about them causes panic.
  silent_orders: true,
  orders_range: "all", // all | range
  orders_from: null,
  orders_to: null,
  page_status: "same", // same | hidden
  order_status_map: {
    completed: { payment: "PAID", fulfilment: "FULFILLED" },
    processing: { payment: "PAID", fulfilment: "UNFULFILLED" },
    "on-hold": { payment: "PENDING", fulfilment: "UNFULFILLED" },
    pending: { payment: "PENDING", fulfilment: "UNFULFILLED" },
    refunded: { payment: "REFUNDED", fulfilment: "UNFULFILLED" },
    cancelled: { payment: "VOIDED", fulfilment: "UNFULFILLED" },
    failed: { payment: "VOIDED", fulfilment: "UNFULFILLED" },
  },
};

const PAYMENT_STATUSES = ["PAID", "PENDING", "AUTHORIZED", "PARTIALLY_PAID", "REFUNDED", "VOIDED"];
const FULFILMENT_STATUSES = ["FULFILLED", "UNFULFILLED"];

const env = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

module.exports = {
  ENTITIES,
  ENTITY_KEYS,
  BY_KEY,
  PLATFORMS,
  PLATFORM_BY_KEY,
  DEFAULT_OPTIONS,
  PAYMENT_STATUSES,
  FULFILMENT_STATUSES,

  /** Records asked of the old store per request — gentle on cheap hosting. */
  PAGE_SIZE: env("MIGRATION_PAGE_SIZE", 50),
  /** A demo moves this many of each data type. */
  DEMO_LIMIT: env("MIGRATION_DEMO_LIMIT", 20),
  /** At or above this many records in a step, Shopify's bulk import is used. */
  BULK_THRESHOLD: env("MIGRATION_BULK_THRESHOLD", 250),
  /** Export pages per file part: a restart repeats at most this many pages. */
  PART_PAGES: env("MIGRATION_PART_PAGES", 10),
  /** Migrations the whole server runs at once. */
  MAX_CONCURRENT: env("MIGRATION_MAX_CONCURRENT", 2),
  /** A lock older than this belongs to a worker that died. */
  STALE_LOCK_MINUTES: env("MIGRATION_STALE_LOCK_MINUTES", 10),
  /** Free disk needed before an export starts. */
  MIN_FREE_DISK_MB: env("MIGRATION_MIN_FREE_DISK_MB", 500),
  RETENTION_DAYS_PERSONAL: env("RETENTION_DAYS_PERSONAL", 30),
  RETENTION_DAYS_OTHER: env("RETENTION_DAYS_OTHER", 90),
};
