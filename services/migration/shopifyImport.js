// services/migration/shopifyImport.js
//
// Everything the migration says to Shopify: one mutation per data type, how
// to read its answer, plus the lookups and clean-up calls around them.
//
// A mutation's answer is turned into one shape for every type:
//
//   { gid, handle, children: [{ sourceId, gid }], errors: [message] }
//
// so the runner records successes and failures the same way whether a record
// went one by one or through a bulk operation.
const shopify = require("../shopify");

/* ------------------------------------------------------------------ */
/* the mutations                                                       */
/* ------------------------------------------------------------------ */

const USER_ERRORS = "userErrors { field message }";

const MUTATIONS = {
  collections: {
    bulk: false,
    root: "collectionCreate",
    query: `mutation Create($input: CollectionInput!) {
      collectionCreate(input: $input) { collection { id handle } ${USER_ERRORS} }
    }`,
    read: (payload) => payload.collection && { gid: payload.collection.id, handle: payload.collection.handle },
  },

  products: {
    bulk: true,
    root: "productSet",
    query: `mutation Set($input: ProductSetInput!, $synchronous: Boolean!) {
      productSet(input: $input, synchronous: $synchronous) {
        product {
          id handle
          variants(first: 250) { nodes { id sku selectedOptions { name value } } }
        }
        ${USER_ERRORS}
      }
    }`,
    read: (payload, line) => {
      const product = payload.product;
      if (!product) return null;
      return { gid: product.id, handle: product.handle, children: matchVariants(product, line) };
    },
  },

  customers: {
    bulk: true,
    root: "customerCreate",
    query: `mutation Create($input: CustomerInput!) {
      customerCreate(input: $input) { customer { id } ${USER_ERRORS} }
    }`,
    read: (payload) => payload.customer && { gid: payload.customer.id },
  },

  orders: {
    bulk: true,
    root: "orderCreate",
    query: `mutation Create($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) { order { id name } ${USER_ERRORS} }
    }`,
    read: (payload) => payload.order && { gid: payload.order.id, handle: payload.order.name },
  },

  coupons: {
    bulk: false,
    // Two kinds of discount, two mutations; the line says which.
    pick: (line) => (line.kind === "free_shipping" ? MUTATIONS.coupons_free_shipping : MUTATIONS.coupons_basic),
  },
  coupons_basic: {
    root: "discountCodeBasicCreate",
    query: `mutation Create($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) { codeDiscountNode { id } ${USER_ERRORS} }
    }`,
    read: (payload) => payload.codeDiscountNode && { gid: payload.codeDiscountNode.id },
  },
  coupons_free_shipping: {
    root: "discountCodeFreeShippingCreate",
    query: `mutation Create($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
      discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) { codeDiscountNode { id } ${USER_ERRORS} }
    }`,
    read: (payload) => payload.codeDiscountNode && { gid: payload.codeDiscountNode.id },
  },

  pages: {
    bulk: false,
    root: "pageCreate",
    query: `mutation Create($page: PageCreateInput!) {
      pageCreate(page: $page) { page { id handle } ${USER_ERRORS} }
    }`,
    read: (payload) => payload.page && { gid: payload.page.id, handle: payload.page.handle },
  },

  posts: {
    bulk: false,
    root: "articleCreate",
    query: `mutation Create($article: ArticleCreateInput!) {
      articleCreate(article: $article) { article { id handle blog { handle } } ${USER_ERRORS} }
    }`,
    read: (payload) =>
      payload.article && {
        gid: payload.article.id,
        handle: `${payload.article.blog ? payload.article.blog.handle : "news"}/${payload.article.handle}`,
      },
  },

  redirects: {
    bulk: false,
    root: "urlRedirectCreate",
    query: `mutation Create($urlRedirect: UrlRedirectInput!) {
      urlRedirectCreate(urlRedirect: $urlRedirect) { urlRedirect { id path target } ${USER_ERRORS} }
    }`,
    read: (payload) => payload.urlRedirect && { gid: payload.urlRedirect.id, handle: payload.urlRedirect.target },
  },
};

function mutationFor(entity, line) {
  const definition = MUTATIONS[entity];
  if (!definition) throw new Error(`No Shopify mutation for ${entity}`);
  return definition.pick ? definition.pick(line) : definition;
}

/**
 * Pair the variants Shopify created with the old variations, by option
 * values first (exact), then SKU.
 */
function matchVariants(product, line) {
  const nodes = (product.variants && product.variants.nodes) || [];
  const children = (line && line.children) || [];

  return children
    .map((child) => {
      const wanted = child.match.values.join("\u0000");
      const byValues = nodes.find(
        (node) => node.selectedOptions.map((option) => option.value).join("\u0000") === wanted
      );
      const bySku = child.match.sku && nodes.find((node) => node.sku === child.match.sku);
      const node = byValues || bySku;
      return node ? { entity: child.entity, sourceId: child.sourceId, gid: node.id } : null;
    })
    .filter(Boolean);
}

/** Turn a mutation's payload into { gid, handle, children, errors }. */
function interpret(entity, line, payload) {
  const definition = mutationFor(entity, line);
  if (!payload) return { errors: ["Shopify returned nothing for this record"] };

  const errors = (payload.userErrors || [])
    .map((error) => `${Array.isArray(error.field) ? `${error.field.join(".")}: ` : ""}${error.message}`)
    .filter(Boolean);

  const created = definition.read(payload, line);
  if (created && created.gid) return { ...created, errors: [] };
  return { errors: errors.length ? errors : ["Shopify did not create this record"] };
}

/**
 * Is this failure about the RECORD (skip it, carry on) or about Shopify or
 * our access (stop the run, resume later)?
 */
function isRecordError(error) {
  if (error.graphql) return true;
  const status = error.response && error.response.status;
  return status === 400 || status === 422;
}

/** Create one record. Never throws for a bad record -- only for an outage. */
async function createOne(shop, entity, line) {
  const definition = mutationFor(entity, line);
  try {
    const data = await shopify.forShop(shop, { query: definition.query, variables: line.variables });
    return interpret(entity, line, data && data[definition.root]);
  } catch (error) {
    if (isRecordError(error)) return { errors: [error.message] };
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* lookups                                                             */
/* ------------------------------------------------------------------ */

async function gql(shop, query, variables) {
  return shopify.forShop(shop, { query, variables });
}

/** The location stock is put in: the shop's primary location. */
async function primaryLocationId(shop) {
  try {
    const data = await gql(shop, "{ locations(first: 1, query: \"active:true\") { nodes { id } } }");
    return data.locations.nodes[0] ? data.locations.nodes[0].id : null;
  } catch (error) {
    console.warn(`Could not read locations for ${shop}: ${error.message}`);
    return null;
  }
}

/** The blog posts go into: the first blog, or a new one called "News". */
async function ensureBlog(shop) {
  const data = await gql(shop, "{ blogs(first: 1) { nodes { id handle } } }");
  if (data.blogs.nodes[0]) return data.blogs.nodes[0];

  const created = await gql(
    shop,
    `mutation { blogCreate(blog: { title: "News" }) { blog { id handle } ${USER_ERRORS} } }`
  );
  const blog = created.blogCreate.blog;
  if (!blog) throw new Error(`Could not create a blog: ${created.blogCreate.userErrors.map((e) => e.message).join("; ")}`);
  return blog;
}

/** Variants that already exist in Shopify with these SKUs: sku -> { productId, handle }. */
async function findSkus(shop, skus) {
  const found = new Map();
  const unique = [...new Set(skus.filter(Boolean))];

  for (let i = 0; i < unique.length; i += 40) {
    const batch = unique.slice(i, i + 40);
    const search = batch.map((sku) => `sku:"${sku.replace(/["\\]/g, "")}"`).join(" OR ");
    const data = await gql(
      shop,
      `query Skus($q: String!) { productVariants(first: 250, query: $q) { nodes { sku product { id handle } } } }`,
      { q: search }
    );
    for (const node of data.productVariants.nodes) {
      if (node.sku && batch.includes(node.sku)) found.set(node.sku, { gid: node.product.id, handle: node.product.handle });
    }
  }
  return found;
}

/** A customer that already has this email. */
async function findCustomerByEmail(shop, email) {
  const data = await gql(
    shop,
    `query Find($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`,
    { q: `email:"${String(email).replace(/["\\]/g, "")}"` }
  );
  return data.customers.nodes[0] ? data.customers.nodes[0].id : null;
}

async function updateCustomer(shop, gid, input) {
  const { email, ...rest } = input;
  const data = await gql(
    shop,
    `mutation Update($input: CustomerInput!) { customerUpdate(input: $input) { customer { id } ${USER_ERRORS} } }`,
    // Addresses are left alone on update: Shopify would add duplicates.
    { input: { id: gid, ...rest, addresses: undefined } }
  );
  return data.customerUpdate.userErrors.map((error) => error.message);
}

async function sendInvite(shop, customerGid) {
  try {
    await gql(
      shop,
      `mutation Invite($customerId: ID!) { customerSendAccountInviteEmail(customerId: $customerId) { ${USER_ERRORS} } }`,
      { customerId: customerGid }
    );
  } catch (error) {
    console.warn(`Invite email failed for ${customerGid}: ${error.message}`);
  }
}

/** The Online Store sales channel, to publish products and collections to. */
async function onlineStorePublicationId(shop) {
  try {
    const data = await gql(shop, "{ publications(first: 20) { nodes { id name } } }");
    const online = data.publications.nodes.find((node) => /online store/i.test(node.name));
    return online ? online.id : null;
  } catch (error) {
    console.warn(`Could not read publications for ${shop}: ${error.message}`);
    return null;
  }
}

async function publish(shop, gid, publicationId) {
  if (!publicationId) return;
  try {
    await gql(
      shop,
      `mutation Publish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { ${USER_ERRORS} } }`,
      { id: gid, input: [{ publicationId }] }
    );
  } catch (error) {
    console.warn(`Publishing ${gid} failed: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* deleting (demo clean-up)                                            */
/* ------------------------------------------------------------------ */

const DELETERS = {
  orders: { query: "mutation D($orderId: ID!) { orderDelete(orderId: $orderId) { userErrors { message } } }", vars: (id) => ({ orderId: id }) },
  customers: { query: "mutation D($input: CustomerDeleteInput!) { customerDelete(input: $input) { userErrors { message } } }", vars: (id) => ({ input: { id } }) },
  products: { query: "mutation D($input: ProductDeleteInput!) { productDelete(input: $input) { userErrors { message } } }", vars: (id) => ({ input: { id } }) },
  collections: { query: "mutation D($input: CollectionDeleteInput!) { collectionDelete(input: $input) { userErrors { message } } }", vars: (id) => ({ input: { id } }) },
  coupons: { query: "mutation D($id: ID!) { discountCodeDelete(id: $id) { userErrors { message } } }", vars: (id) => ({ id }) },
  pages: { query: "mutation D($id: ID!) { pageDelete(id: $id) { userErrors { message } } }", vars: (id) => ({ id }) },
  posts: { query: "mutation D($id: ID!) { articleDelete(id: $id) { userErrors { message } } }", vars: (id) => ({ id }) },
  redirects: { query: "mutation D($id: ID!) { urlRedirectDelete(id: $id) { userErrors { message } } }", vars: (id) => ({ id }) },
};

/** Delete one record from Shopify. True when it is gone (or already was). */
async function deleteRecord(shop, entity, gid) {
  const deleter = DELETERS[entity];
  if (!deleter) return true; // variants go with their product
  try {
    const data = await gql(shop, deleter.query, deleter.vars(gid));
    const payload = Object.values(data || {})[0] || {};
    const errors = (payload.userErrors || []).map((error) => error.message);
    return !errors.length || errors.some((message) => /not exist|not found|could not be found/i.test(message));
  } catch (error) {
    if (isRecordError(error)) return /not exist|not found/i.test(error.message);
    throw error;
  }
}

module.exports = {
  MUTATIONS,
  mutationFor,
  interpret,
  createOne,
  isRecordError,
  primaryLocationId,
  ensureBlog,
  findSkus,
  findCustomerByEmail,
  updateCustomer,
  sendInvite,
  onlineStorePublicationId,
  publish,
  deleteRecord,
  matchVariants,
};
