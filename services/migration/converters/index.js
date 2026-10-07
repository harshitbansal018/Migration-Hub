// services/migration/converters/index.js
//
// The converter for a platform. A plain WordPress site has only pages and
// posts, which come from the same wp/v2 API WooCommerce sites use, so it
// shares those converters.
const woocommerce = require("./woocommerce");

const CONVERTERS = {
  woocommerce,
  wordpress: {
    prepare: {},
    convert: { pages: woocommerce.convert.pages, posts: woocommerce.convert.posts },
  },
};

function converterFor(platform) {
  const converter = CONVERTERS[platform];
  if (!converter) throw new Error(`No converter for ${platform}`);
  return converter;
}

module.exports = { converterFor };
