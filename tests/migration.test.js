/* End-to-end test of the migration engine, with no MySQL, no WooCommerce
 * and no Shopify: the models, the old store and the Shopify API are replaced
 * by in-memory fakes, and the real runner, converters, storage and bulk code
 * move "Chai & Co" -- the example from docs/Migration-How-It-Works.pdf.
 *
 * Checks what the design promises: the order of moving, linking orders to
 * their products and customer through id_map, failures written to
 * errors.csv without stopping the run, no duplicates, resuming after a
 * crash, retrying failures, "Migrate recent data", and Shopify bulk
 * operations for big jobs.
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const Module = require("module");

const SERVER = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"));

process.env.TOKEN_ENCRYPTION_KEY = "1".repeat(64);
process.env.STORAGE_DIR = TMP;
process.env.SOURCE_PAUSE_MS = "0";
process.env.BULK_POLL_MS = "5";
process.env.MIGRATION_MIN_FREE_DISK_MB = "1";
process.env.MIGRATION_PAGE_SIZE = "2"; // tiny pages, so paging and resume are exercised

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ""}`);
  }
}

function stub(relative, exports) {
  const file = require.resolve(path.join(SERVER, relative));
  const mod = new Module(file, null);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[file] = mod;
}

/* ------------------------------------------------------------------ */
/* the old store: Chai & Co on WooCommerce                             */
/* ------------------------------------------------------------------ */

const source = {
  collections: [{ id: 5, name: "Tea", slug: "tea", parent: 0 }],
  products: [
    {
      id: 101, name: "Masala Chai", slug: "masala-chai", type: "variable", status: "publish",
      permalink: "https://chaiandco.com/product/masala-chai/", categories: [{ id: 5, name: "Tea" }],
      attributes: [{ name: "Size", variation: true, options: ["100g", "250g"] }],
      variations_data: [
        { id: 111, sku: "MC-100", regular_price: "8", attributes: [{ name: "Size", option: "100g" }] },
        { id: 112, sku: "MC-250", regular_price: "15", attributes: [{ name: "Size", option: "250g" }] },
      ],
    },
    { id: 102, name: "Green Tea", slug: "green-tea", type: "simple", status: "publish", sku: "GT-1", regular_price: "6", permalink: "https://chaiandco.com/product/green-tea/", categories: [] },
    { id: 103, name: "Gift Box", slug: "gift-box", type: "grouped", grouped_products: [101, 102] },
  ],
  customers: [
    { id: 201, email: "aman@example.com", first_name: "Aman", last_name: "K", billing: { city: "Delhi", country: "IN", address_1: "1 Rd" } },
    { id: 202, email: "neha@example.com", first_name: "Neha", last_name: "S", billing: { city: "Pune", country: "IN", address_1: "2 Rd" } },
  ],
  orders: [
    { id: 301, number: 1045, status: "completed", currency: "INR", customer_id: 201, date_created_gmt: "2026-09-01T10:00:00", line_items: [{ product_id: 101, variation_id: 112, quantity: 2, subtotal: "30", name: "Masala Chai - 250g" }], billing: { email: "aman@example.com" } },
    { id: 302, number: 1046, status: "processing", currency: "INR", customer_id: 202, date_created_gmt: "2026-09-02T10:00:00", line_items: [{ product_id: 102, variation_id: 0, quantity: 1, subtotal: "6", name: "Green Tea" }], billing: { email: "neha@example.com" } },
  ],
};

let sourceRequests = 0;
const fakeAdapter = {
  platform: "woocommerce",
  async fetchPage(entity, { page, perPage, include, modifiedAfter }) {
    sourceRequests += 1;
    let all = source[entity] || [];
    if (include) all = all.filter((record) => include.map(String).includes(String(record.id)));
    if (modifiedAfter) all = all.filter((record) => (record.date_modified || "2026-01-01") > modifiedAfter);
    const start = (page - 1) * perPage;
    return { records: JSON.parse(JSON.stringify(all.slice(start, start + perPage))), total: all.length, totalPages: Math.ceil(all.length / perPage) };
  },
};

/* ------------------------------------------------------------------ */
/* Shopify                                                             */
/* ------------------------------------------------------------------ */

const shopifyState = { next: 9000, created: [], redirects: new Set(), failNextCustomer: false, uploads: new Map(), ops: new Map() };
const gid = (type) => `gid://shopify/${type}/${(shopifyState.next += 1)}`;

/** Answer one mutation the way Shopify would. */
function answer(query, variables) {
  if (/productSet\(/.test(query)) {
    const input = variables.input;
    const id = input.id || gid("Product");
    const product = {
      id,
      handle: input.handle,
      variants: { nodes: input.variants.map((variant) => ({ id: gid("ProductVariant"), sku: variant.sku || null, selectedOptions: variant.optionValues.map((o) => ({ name: o.optionName, value: o.name })) })) },
    };
    shopifyState.created.push({ type: input.id ? "product-update" : "product", input });
    return { productSet: { product, userErrors: [] } };
  }
  if (/collectionCreate/.test(query)) {
    shopifyState.created.push({ type: "collection", input: variables.input });
    return { collectionCreate: { collection: { id: gid("Collection"), handle: variables.input.handle }, userErrors: [] } };
  }
  if (/customerCreate/.test(query)) {
    if (shopifyState.failNextCustomer) {
      shopifyState.failNextCustomer = false;
      const error = new Error("socket hang up");
      error.code = "ECONNRESET";
      throw error;
    }
    shopifyState.created.push({ type: "customer", input: variables.input });
    return { customerCreate: { customer: { id: gid("Customer") }, userErrors: [] } };
  }
  if (/orderCreate/.test(query)) {
    shopifyState.created.push({ type: "order", input: variables.order, options: variables.options });
    return { orderCreate: { order: { id: gid("Order"), name: variables.order.name || "#1001" }, userErrors: [] } };
  }
  if (/publishablePublish/.test(query)) return { publishablePublish: { userErrors: [] } };
  if (/urlRedirectCreate/.test(query)) {
    const { path: from, target } = variables.urlRedirect;
    if (shopifyState.redirects.has(from)) return { urlRedirectCreate: { urlRedirect: null, userErrors: [{ field: ["path"], message: "Path has already been taken" }] } };
    shopifyState.redirects.add(from);
    return { urlRedirectCreate: { urlRedirect: { id: gid("UrlRedirect"), path: from, target }, userErrors: [] } };
  }
  throw new Error(`Unexpected mutation: ${query.slice(0, 60)}`);
}

const fakeShopify = {
  async forShop(shop, { query, variables }) {
    if (/locations\(/.test(query)) return { locations: { nodes: [{ id: "gid://shopify/Location/1" }] } };
    if (/publications\(/.test(query)) return { publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }] } };
    if (/publishablePublish/.test(query)) return { publishablePublish: { userErrors: [] } };
    if (/productVariants\(/.test(query)) return { productVariants: { nodes: [] } };
    if (/stagedUploadsCreate/.test(query)) {
      return { stagedUploadsCreate: { stagedTargets: [{ url: "https://upload.test/", resourceUrl: null, parameters: [{ name: "key", value: `upload-${shopifyState.uploads.size + 1}` }] }], userErrors: [] } };
    }
    if (/bulkOperationRunMutation/.test(query)) {
      const lines = shopifyState.uploads.get(variables.path).split("\n").filter(Boolean);
      const results = lines.map((line, index) => JSON.stringify({ data: answer(variables.mutation, JSON.parse(line)), __lineNumber: index }));
      const id = `gid://shopify/BulkOperation/${shopifyState.ops.size + 1}`;
      shopifyState.ops.set(id, { results: results.join("\n"), polls: 0, count: lines.length });
      return { bulkOperationRunMutation: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } };
    }
    if (/BulkOperation/.test(query) && variables && variables.id) {
      const op = shopifyState.ops.get(variables.id);
      op.polls += 1;
      return { node: { id: variables.id, status: op.polls > 1 ? "COMPLETED" : "RUNNING", objectCount: String(op.count), url: `https://results.test/${encodeURIComponent(variables.id)}`, errorCode: null, partialDataUrl: null } };
    }
    return answer(query, variables);
  },
};

global.fetch = async (url, init) => {
  if (url === "https://upload.test/") {
    const form = init.body;
    shopifyState.uploads.set(form.get("key"), await form.get("file").text());
    return { ok: true, status: 204 };
  }
  const op = shopifyState.ops.get(decodeURIComponent(url.replace("https://results.test/", "")));
  return new Response(op.results);
};

/* ------------------------------------------------------------------ */
/* the database                                                        */
/* ------------------------------------------------------------------ */

const db = { migrations: new Map(), steps: [], idMap: new Map(), nextStep: 1 };
const store = { id: 1, shop_domain: "chaiandco.myshopify.com", currency: "INR", is_active: true, email: null };
const connection = { id: 1, store_id: 1, platform: "woocommerce", base_url: "https://chaiandco.com", credentials: {}, scan_counts: {} };
const { BY_KEY } = require(path.join(SERVER, "services/migration/constants"));

function createMigration(id, type, entities, options = {}) {
  const migration = {
    id, store_id: 1, source_connection_id: 1, type, status: "running", phase: "export", entities, options,
    storage_path: `storage/migrations/woocommerce/chaiandco.myshopify.com/${id}`, worker_id: "w1", platform: "woocommerce", base_url: connection.base_url,
  };
  db.migrations.set(id, migration);
  for (const entity of entities) {
    db.steps.push({
      id: db.nextStep++, migration_id: id, entity, position: BY_KEY[entity].position, status: "pending", phase: null,
      total: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, exported: 0, imported: 0, export_page: 0, import_line: 0, bulk_operation_id: null,
    });
  }
  return migration;
}

function totals(id) {
  return db.steps.filter((step) => step.migration_id === id).reduce((sum, step) => {
    for (const key of ["succeeded", "failed", "skipped", "processed", "total"]) sum[key] = (sum[key] || 0) + step[key];
    return sum;
  }, {});
}

stub("config/db.js", { query: async () => [], pool: { query: async () => [[], []] }, withTransaction: async () => {} });
stub("models/migrationModel.js", {
  ACTIVE: ["queued", "running", "paused"],
  async steps(id) {
    return db.steps.filter((step) => step.migration_id === id).sort((a, b) => a.position - b.position).map((step) => ({ ...step, label: BY_KEY[step.entity].label }));
  },
  async touch(id) {
    const migration = db.migrations.get(id);
    return migration.status;
  },
  async release(id) { db.migrations.get(id).worker_id = null; },
  async setPhase(id, phase) { db.migrations.get(id).phase = phase; },
  async finish(id, workerId, { status }) { Object.assign(db.migrations.get(id), { status, finished_at: new Date() }); },
  async fail(id, workerId, error) { Object.assign(db.migrations.get(id), { status: "failed", last_error: error }); },
  async findById(id) { return { ...db.migrations.get(id), ...totals(id) }; },
  async updateStep(stepId, fields) {
    const step = db.steps.find((row) => row.id === stepId);
    for (const [key, value] of Object.entries(fields)) {
      if (value && typeof value === "object" && value.raw) {
        const [, column, amount] = value.raw.match(/^(\w+) \+ (-?\d+)$/);
        step[key] = step[column] + Number(amount);
      } else {
        step[key] = value;
      }
    }
  },
});
stub("models/idMapModel.js", {
  async loadMap(connectionId, entities) {
    const map = new Map();
    for (const [key, row] of db.idMap) if (entities.includes(row.entity)) map.set(key, { gid: row.gid, handle: row.handle, hash: row.hash, migrationId: row.migrationId });
    return { get: (e, id) => map.get(`${e}:${id}`) || null, set: (e, id, v) => map.set(`${e}:${id}`, v), has: (e, id) => map.has(`${e}:${id}`) };
  },
  async save(rows) { for (const row of rows) db.idMap.set(`${row.entity}:${row.sourceId}`, { ...row, sourceId: String(row.sourceId) }); },
  async redirectSources() {
    return [...db.idMap.values()]
      .filter((row) => row.sourceUrl && row.handle && ["collections", "products", "pages", "posts"].includes(row.entity))
      .map((row) => ({ entity: row.entity, source_id: row.sourceId, source_url: row.sourceUrl, shopify_handle: row.handle, migration_id: row.migrationId }));
  },
});
stub("models/sourceConnectionModel.js", { async findWithCredentials() { return connection; } });
stub("models/storeModel.js", { async findById() { return store; } });
stub("services/mailer.js", { async migrationFinished() { return false; } });
stub("services/shopify.js", fakeShopify);
stub("services/migration/sources/index.js", { adapterFor: () => fakeAdapter });

const runner = require(path.join(SERVER, "services/migration/runner"));
const storage = require(path.join(SERVER, "services/migration/storage"));
const { DEFAULT_OPTIONS } = require(path.join(SERVER, "services/migration/constants"));

const ALL = ["collections", "products", "customers", "orders", "redirects"];
const count = (type) => shopifyState.created.filter((item) => item.type === type).length;

(async () => {
  /* ---------------- 1. a full migration, one by one, with a crash ---------------- */
  console.log("\nFull migration of Chai & Co (one by one)");
  const m7 = createMigration(7, "full", ALL, { ...DEFAULT_OPTIONS });

  shopifyState.failNextCustomer = true; // Shopify drops the connection mid-run
  await runner.run(m7, { workerId: "w1" });
  check("an outage stops the run as failed, with a message", m7.status === "failed" && /Shopify could not be reached/.test(m7.last_error), m7.last_error);
  check("products were already created before the outage", count("product") === 2);

  // The merchant presses Resume.
  m7.status = "running";
  m7.last_error = null;
  await runner.run(m7, { workerId: "w1" });
  check("resumed run completes", m7.status === "completed", m7.status);
  check("nothing duplicated across the restart: 2 products", count("product") === 2, count("product"));
  check("2 customers, 2 orders, 1 collection", count("customer") === 2 && count("order") === 2 && count("collection") === 1);

  const sum = totals(7);
  check("counters: 8 migrated (1 collection, 2 products, 2 customers, 2 orders, ... redirects)", sum.succeeded === 1 + 2 + 2 + 2 + 3, sum);
  check("counters: 1 failed (Gift Box)", sum.failed === 1, sum);

  const errors = await storage.readErrors(m7.storage_path);
  check("errors.csv explains the Gift Box", errors.length === 1 && errors[0].sourceId === "103" && /Grouped product/.test(errors[0].reason), errors);

  const order1045 = shopifyState.created.find((item) => item.type === "order" && item.input.tags.includes("WooCommerce #1045")).input;
  const aman = db.idMap.get("customers:201").gid;
  const size250 = db.idMap.get("variant:112").gid;
  check("order #1045 is linked to Aman through id_map", order1045.customer.toAssociate.id === aman, order1045.customer);
  check("order #1045 points at Masala Chai 250g", order1045.lineItems[0].variantId === size250, order1045.lineItems[0]);
  const order1046 = shopifyState.created.find((item) => item.type === "order" && item.input.tags.includes("WooCommerce #1046")).input;
  check("a simple product's line finds its default variant", order1046.lineItems[0].variantId === db.idMap.get("variant:p102").gid);
  const options1045 = shopifyState.created.find((item) => item.type === "order").options;
  check("customers are not emailed about old orders", options1045.sendReceipt === false && options1045.sendFulfillmentReceipt === false, options1045);
  check("redirect /product/masala-chai/ -> /products/masala-chai", shopifyState.redirects.has("/product/masala-chai/"));
  check("category redirect built from its slug path", shopifyState.redirects.has("/product-category/tea/"));

  const files = fs.readdirSync(path.join(TMP, "migrations/woocommerce/chaiandco.myshopify.com/7/export"));
  check("export files are encrypted, compressed parts", files.length >= 4 && files.every((name) => /\.part-\d{6}\.jsonl\.gz\.enc$/.test(name)), files);
  const raw = fs.readFileSync(path.join(TMP, "migrations/woocommerce/chaiandco.myshopify.com/7/import/customers.jsonl.enc"));
  check("no customer email readable on disk", !raw.includes("aman@example.com"));

  /* ---------------- 2. run it again: nothing is duplicated ---------------- */
  console.log("\nThe same migration again");
  const before = shopifyState.created.length;
  const m8 = createMigration(8, "full", ALL, { ...DEFAULT_OPTIONS });
  await runner.run(m8, { workerId: "w1" });
  check("completes", m8.status === "completed");
  check("creates nothing new", shopifyState.created.length === before, shopifyState.created.length - before);
  check("everything is counted as skipped (already existed)", totals(8).skipped >= 7, totals(8));

  /* ---------------- 3. migrate recent data ---------------- */
  console.log("\nMigrate recent data: one new order, one changed product");
  source.orders.push({ id: 303, number: 1047, status: "processing", currency: "INR", customer_id: 202, date_created_gmt: "2026-10-01T10:00:00", date_modified: "2026-10-01T10:00:00", line_items: [{ product_id: 102, quantity: 3, subtotal: "18", name: "Green Tea" }] });
  source.products[1] = { ...source.products[1], regular_price: "7", date_modified: "2026-10-01T09:00:00" };
  const m9 = createMigration(9, "delta", ALL, { ...DEFAULT_OPTIONS, modified_after: "2026-09-15T00:00:00" });
  await runner.run(m9, { workerId: "w1" });
  check("completes", m9.status === "completed");
  check("only order #1047 is created", count("order") === 3 && shopifyState.created.filter((i) => i.type === "order").at(-1).input.tags.includes("WooCommerce #1047"), count("order"));
  check("the changed product is updated in place, not duplicated", count("product") === 2 && count("product-update") === 1, { created: count("product"), updated: count("product-update") });

  /* ---------------- 4. retry failed ---------------- */
  console.log("\nRetry failed, after the merchant fixed the Gift Box");
  source.products[2] = { id: 103, name: "Gift Box", slug: "gift-box", type: "simple", status: "publish", regular_price: "20", permalink: "https://chaiandco.com/product/gift-box/" };
  const m10 = createMigration(10, "retry", ["products"], { ...DEFAULT_OPTIONS, include: { products: ["103"] } });
  const requestsBefore = sourceRequests;
  await runner.run(m10, { workerId: "w1" });
  check("completes", m10.status === "completed");
  check("asks the old store for the failed record only", sourceRequests - requestsBefore === 1, sourceRequests - requestsBefore);
  check("the Gift Box is now in Shopify", Boolean(db.idMap.get("products:103")));

  /* ---------------- 5. pause ---------------- */
  console.log("\nPause");
  const m11 = createMigration(11, "full", ["customers"], { ...DEFAULT_OPTIONS });
  for (let i = 0; i < 6; i += 1) source.customers.push({ id: 400 + i, email: `c${i}@example.com`, first_name: "C" });
  const originalTouch = require.cache[require.resolve(path.join(SERVER, "models/migrationModel.js"))].exports.touch;
  let touches = 0;
  require.cache[require.resolve(path.join(SERVER, "models/migrationModel.js"))].exports.touch = async (id) => {
    touches += 1;
    if (touches === 2) db.migrations.get(id).status = "paused";
    return originalTouch(id);
  };
  await runner.run(m11, { workerId: "w1" });
  const step11 = db.steps.find((step) => step.migration_id === 11);
  check("stops when paused, keeping its status", m11.status === "paused", m11.status);
  check("and remembers where it was", step11.export_page > 0 || step11.import_line > 0, step11);
  require.cache[require.resolve(path.join(SERVER, "models/migrationModel.js"))].exports.touch = originalTouch;
  m11.status = "running";
  await runner.run(m11, { workerId: "w1" });
  check("Resume finishes it", m11.status === "completed" && step11.succeeded === 6, step11);

  /* ---------------- 6. Shopify bulk operations ---------------- */
  console.log("\nA big job goes through a Shopify bulk operation");
  const C = require(path.join(SERVER, "services/migration/constants"));
  C.BULK_THRESHOLD = 3;
  for (let i = 0; i < 9; i += 1) {
    source.products.push({ id: 500 + i, name: `Tea ${i}`, slug: `tea-${i}`, type: "simple", status: "publish", sku: `T-${i}`, regular_price: "5", permalink: `https://chaiandco.com/product/tea-${i}/` });
  }
  const opsBefore = shopifyState.ops.size;
  const m12 = createMigration(12, "full", ["products"], { ...DEFAULT_OPTIONS });
  await runner.run(m12, { workerId: "w1" });
  const step12 = db.steps.find((step) => step.migration_id === 12);
  check("completes", m12.status === "completed", m12.last_error);
  check("used a bulk operation (plus one to publish)", shopifyState.ops.size - opsBefore >= 1, shopifyState.ops.size - opsBefore);
  check("all 9 new products mapped from Shopify's result file", [...Array(9).keys()].every((i) => db.idMap.get(`products:${50 + 450 + i}`)), step12);
  check("bulk counters add up", step12.succeeded === 9 && step12.processed === step12.total, step12);

  /* ---------------- 7. paused while Shopify is working ---------------- */
  console.log("\nPaused while Shopify runs the bulk operation, then resumed");
  for (let i = 0; i < 5; i += 1) {
    source.products.push({ id: 600 + i, name: `Herb ${i}`, slug: `herb-${i}`, type: "simple", status: "publish", regular_price: "4", permalink: `https://chaiandco.com/product/herb-${i}/` });
  }
  const modelExports = require.cache[require.resolve(path.join(SERVER, "models/migrationModel.js"))].exports;
  const realTouch = modelExports.touch;
  const m13 = createMigration(13, "full", ["products"], { ...DEFAULT_OPTIONS, publish_online_store: false });
  modelExports.touch = async (id) => {
    const step = db.steps.find((row) => row.migration_id === id);
    if (step.bulk_operation_id) db.migrations.get(id).status = "paused"; // merchant presses Pause
    return realTouch(id);
  };
  const productsBefore = count("product");
  const opsBefore13 = shopifyState.ops.size;
  await runner.run(m13, { workerId: "w1" });
  check("stops while Shopify works, keeping the operation id", m13.status === "paused" && Boolean(db.steps.find((s) => s.migration_id === 13).bulk_operation_id));
  modelExports.touch = realTouch;
  m13.status = "running";
  await runner.run(m13, { workerId: "w1" });
  check("resume completes", m13.status === "completed", m13.last_error);
  check("waits for the SAME operation instead of starting another", shopifyState.ops.size - opsBefore13 === 1, shopifyState.ops.size - opsBefore13);
  check("5 products created exactly once", count("product") - productsBefore === 5, count("product") - productsBefore);
  check("sidecar removed when done", !fs.existsSync(path.join(TMP, "migrations/woocommerce/chaiandco.myshopify.com/13/import/products.bulk.json")));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
