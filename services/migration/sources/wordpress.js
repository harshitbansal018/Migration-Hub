// services/migration/sources/wordpress.js
//
// A plain WordPress site: pages and blog posts through the wp/v2 REST API.
//
// Published content is public, so no keys are required. A merchant who also
// wants drafts can give a username and an Application Password (WordPress ->
// Users -> Profile -> Application Passwords); it is sent as HTTP Basic auth.
const { getJson, totals, SourceError } = require("./http");

const WP = "/wp-json/wp/v2";

const ENDPOINTS = {
  pages: { path: `${WP}/pages`, what: "Pages" },
  posts: { path: `${WP}/posts`, what: "Blog posts" },
};

function create(connection, { onRetry } = {}) {
  const base = connection.base_url;
  const credentials = connection.credentials || {};
  const auth = credentials.username && credentials.app_password
    ? { username: credentials.username, password: credentials.app_password }
    : undefined;

  const get = (path, params, what) => getJson(`${base}${path}`, { params, auth, what, onRetry });

  async function count(entity, params = {}) {
    const endpoint = ENDPOINTS[entity];
    const { headers } = await get(endpoint.path, { per_page: 1, ...params, ...(auth ? { status: "any" } : {}) }, endpoint.what);
    return totals(headers).total;
  }

  async function test() {
    let name = null;
    try {
      const { data } = await getJson(`${base}/wp-json/`, { what: "The WordPress API", onRetry });
      name = data && data.name;
      if (!data || !Array.isArray(data.namespaces) || !data.namespaces.includes("wp/v2")) {
        throw new SourceError("This site's WordPress REST API is turned off. Enable it, or ask your developer.");
      }
    } catch (error) {
      if (error.status === 404) {
        throw new SourceError("We could not find WordPress at this address. Check the URL.");
      }
      throw error;
    }

    const counts = {};
    for (const entity of Object.keys(ENDPOINTS)) counts[entity] = await count(entity);

    return { version: name ? `WordPress · ${String(name).slice(0, 40)}` : "WordPress", counts, meta: {} };
  }

  async function fetchPage(entity, { page, perPage, include }) {
    const endpoint = ENDPOINTS[entity];
    if (!endpoint) throw new Error(`WordPress cannot supply ${entity}`);

    const params = { page, per_page: perPage, _embed: 1, order: "asc", orderby: "id" };
    if (auth) params.status = "any";
    if (include && include.length) params.include = include.join(",");

    const { data, headers } = await get(endpoint.path, params, endpoint.what);
    return { records: Array.isArray(data) ? data : [], ...totals(headers) };
  }

  return { platform: "wordpress", test, count, countOrders: async () => 0, fetchPage };
}

module.exports = { create, ENDPOINTS };
