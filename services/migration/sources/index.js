// services/migration/sources/index.js
//
// One adapter per platform. Every adapter has the same shape:
//
//   test()                     -> { version, counts, meta }
//   count(entity, params)      -> number
//   countOrders({after,before})-> number
//   fetchPage(entity, opts)    -> { records, total, totalPages }
//
// To add a platform: write sources/<platform>.js and converters/<platform>.js,
// add it here, and set available: true in constants.PLATFORMS.
const woocommerce = require("./woocommerce");
const wordpress = require("./wordpress");
const { SourceError, normalizeBaseUrl } = require("./http");

const ADAPTERS = { woocommerce, wordpress };

function adapterFor(connection, options) {
  const adapter = ADAPTERS[connection.platform];
  if (!adapter) throw new SourceError(`${connection.platform} is not supported yet.`);
  return adapter.create(connection, options);
}

/**
 * Which credential fields each platform takes, how to check them, and the
 * masked hint the screen shows afterwards ("ck_4f9a…c21e"). The keys
 * themselves are never sent back to a browser.
 */
const CREDENTIALS = {
  woocommerce: {
    fields: ["consumer_key", "consumer_secret"],
    validate(input) {
      const key = String(input.consumer_key || "").trim();
      const secret = String(input.consumer_secret || "").trim();
      if (!/^ck_[A-Za-z0-9]{20,64}$/.test(key)) {
        throw new SourceError("The consumer key should start with ck_ — copy it again from WooCommerce.");
      }
      if (!/^cs_[A-Za-z0-9]{20,64}$/.test(secret)) {
        throw new SourceError("The consumer secret should start with cs_ — copy it again from WooCommerce.");
      }
      return { consumer_key: key, consumer_secret: secret };
    },
    hint: (credentials) => mask(credentials.consumer_key),
  },
  wordpress: {
    fields: ["username", "app_password"],
    validate(input) {
      const username = String(input.username || "").trim().slice(0, 100);
      const appPassword = String(input.app_password || "").replace(/\s+/g, "").slice(0, 100);
      if (Boolean(username) !== Boolean(appPassword)) {
        throw new SourceError("Enter both a username and an application password, or leave both empty.");
      }
      return username ? { username, app_password: appPassword } : {};
    },
    hint: (credentials) => (credentials.username ? `${credentials.username} · ${mask(credentials.app_password)}` : "Public content only"),
  },
};

function mask(value) {
  const text = String(value || "");
  if (text.length <= 10) return "••••";
  return `${text.slice(0, 7)}…${text.slice(-4)}`;
}

module.exports = { adapterFor, CREDENTIALS, normalizeBaseUrl, SourceError, mask };
