// services/migration/sources/woocommerce.js
//
// Reads a WooCommerce store through its REST API (wc/v3) with read-only
// consumer keys. Keys go in HTTP Basic auth, which WooCommerce accepts over
// https -- never as query parameters, which end up in server logs.
//
// Pages and blog posts come from the WordPress API (wp/v2) on the same site.
// That API is public for published content, so WooCommerce keys are not sent
// to it.
const { getJson, totals, pathOf, SourceError } = require("./http");

const WC = "/wp-json/wc/v3";
const WP = "/wp-json/wp/v2";

/** Where each data type lives, and what the merchant calls it. */
const ENDPOINTS = {
  collections: { path: `${WC}/products/categories`, what: "Product categories" },
  products: { path: `${WC}/products`, what: "Products", delta: true },
  customers: { path: `${WC}/customers`, what: "Customers" },
  orders: { path: `${WC}/orders`, what: "Orders", delta: true, dated: true },
  coupons: { path: `${WC}/coupons`, what: "Coupons", delta: true },
  pages: { path: `${WP}/pages`, what: "Pages", wp: true },
  posts: { path: `${WP}/posts`, what: "Blog posts", wp: true },
};

function create(connection, { onRetry } = {}) {
  const base = connection.base_url;
  const credentials = connection.credentials || {};
  const auth = { username: credentials.consumer_key, password: credentials.consumer_secret };

  function get(path, params, what) {
    const endpoint = Object.values(ENDPOINTS).find((item) => item.path === path);
    const wp = endpoint ? endpoint.wp : path.startsWith(WP);
    return getJson(`${base}${path}`, { params, auth: wp ? undefined : auth, what, onRetry });
  }

  /** How many records a list endpoint has, from one tiny request. */
  async function count(entity, params = {}) {
    const endpoint = ENDPOINTS[entity];
    try {
      const { headers } = await get(endpoint.path, { per_page: 1, ...params }, endpoint.what);
      return totals(headers).total;
    } catch (error) {
      // Pages/posts are optional: a site with the WP API locked down still
      // migrates its shop.
      if (endpoint.wp) return 0;
      throw error;
    }
  }

  /**
   * Prove the keys work and see what is there. Returns what the wizard shows:
   * { version, counts }.
   */
  async function test() {
    let version = null;
    let weightUnit = "kg";

    try {
      const { data } = await get(`${WC}/system_status`, { _fields: "environment,settings" }, "WooCommerce");
      version = data && data.environment && data.environment.version;
      weightUnit = (data && data.settings && data.settings.weight_unit) || weightUnit;
    } catch (error) {
      // system_status needs the keys to belong to an admin. If the keys are
      // simply wrong, the products call below says so; otherwise carry on
      // without a version number.
      if (error.status !== 401 && error.status !== 403 && error.status !== 404) throw error;
      if (error.status === 404) {
        throw new SourceError(
          "We could not find WooCommerce at this address. Check the URL, and that WooCommerce is active."
        );
      }
    }

    const counts = {};
    for (const entity of Object.keys(ENDPOINTS)) counts[entity] = await count(entity);

    return {
      version: version ? `WooCommerce ${version}` : "WooCommerce",
      counts,
      meta: { weightUnit },
    };
  }

  /** How many orders fall in a date range, for the Review step. */
  async function countOrders({ after, before } = {}) {
    return count("orders", { after: after || undefined, before: before || undefined });
  }

  /** Every variation of a variable product (they are not in the product list). */
  async function variations(productId) {
    const all = [];
    for (let page = 1; page <= 50; page += 1) {
      const { data, headers } = await get(
        `${WC}/products/${productId}/variations`,
        { per_page: 100, page },
        "Product variations"
      );
      all.push(...data);
      if (page >= (totals(headers).totalPages || 1)) break;
    }
    return all;
  }

  /**
   * One page of records, exactly as WooCommerce sends them.
   *
   *   page        1-based
   *   perPage     PAGE_SIZE, or the demo limit
   *   include     only these source ids (a retry run)
   *   after/before   orders date range (ISO)
   *   modifiedAfter  only records changed since (a delta run)
   *
   * Returns { records, total, totalPages }.
   */
  async function fetchPage(entity, { page, perPage, include, after, before, modifiedAfter }) {
    const endpoint = ENDPOINTS[entity];
    if (!endpoint) throw new Error(`WooCommerce cannot supply ${entity}`);

    const params = { page, per_page: perPage, orderby: "id", order: "asc" };
    if (entity === "orders") params.status = "any";
    if (entity === "posts" || entity === "pages") params._embed = 1;
    if (include && include.length) params.include = include.join(",");
    if (endpoint.dated) {
      if (after) params.after = after;
      if (before) params.before = before;
    }
    if (modifiedAfter && endpoint.delta) params.modified_after = modifiedAfter;
    // WordPress lists published content without auth; drafts stay behind.
    if (endpoint.wp) delete params.orderby;

    const { data, headers } = await get(endpoint.path, params, endpoint.what);
    const records = Array.isArray(data) ? data : [];

    // Variable products carry only variation ids; fetch the variations so the
    // export file holds the whole product on one line.
    if (entity === "products") {
      for (const product of records) {
        if (product.type === "variable" && Array.isArray(product.variations) && product.variations.length) {
          product.variations_data = await variations(product.id);
        }
      }
    }

    return { records, ...totals(headers) };
  }

  return { platform: "woocommerce", test, count, countOrders, fetchPage, pathOf };
}

module.exports = { create, ENDPOINTS };
