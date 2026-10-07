// services/migration/converters/woocommerce.js
//
// WooCommerce (and its WordPress pages/posts) -> Shopify Admin GraphQL input.
//
// Each convert function takes ONE raw record and a context, and returns one
// of:
//
//   { line }    ready for Shopify. line = { sourceId, name, hash, sourceUrl,
//               handle, variables, children, updateGid }
//   { fail }    Shopify cannot accept it; the reason goes to errors.csv
//   { skip }    deliberately not moved (e.g. the SKU already exists)
//
// The context carries what conversion needs from outside the record:
//
//   ctx.options       the wizard's Options step
//   ctx.idMap         lookups of already-migrated records (old id -> Shopify)
//   ctx.locationId    Shopify location stock goes to
//   ctx.weightUnit    the old store's weight unit
//   ctx.blog          { id, handle } articles are created in
//   ctx.categoryPaths category id -> its old URL path (prepared first)
//
// `name` is shown in errors.csv, so for customers and orders it is NEVER the
// person's name or email -- only "Customer #201" / "Order #1045".
const {
  hashRecord,
  decodeEntities,
  stripTags,
  toHandle,
  money,
  gmtIso,
  e164,
  cleanEmail,
  compact,
  address,
  sameAddress,
  fail,
  skip,
} = require("./common");
const { pathOf } = require("../sources/http");

const WEIGHT_UNITS = { kg: "KILOGRAMS", g: "GRAMS", lbs: "POUNDS", lb: "POUNDS", oz: "OUNCES" };
const MAX_OPTIONS = 3;
const MAX_VARIANTS = 2048;

/* ------------------------------------------------------------------ */
/* collections                                                         */
/* ------------------------------------------------------------------ */

/** Categories nest (/product-category/tea/green/), so build every path first. */
function prepareCollections(records) {
  const byId = new Map(records.map((category) => [category.id, category]));
  const paths = new Map();

  for (const category of records) {
    const slugs = [];
    let current = category;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      slugs.unshift(current.slug);
      current = current.parent ? byId.get(current.parent) : null;
    }
    paths.set(category.id, `/product-category/${slugs.join("/")}/`);
  }
  return { categoryPaths: paths };
}

function collection(category, ctx) {
  const title = decodeEntities(category.name);
  if (!title) return fail("Category has no name");
  if (category.slug === "uncategorized") return skip("WooCommerce's default “Uncategorized” category");

  const handle = toHandle(category.slug || title);

  return {
    line: {
      sourceId: String(category.id),
      name: title,
      hash: hashRecord(category),
      sourceUrl: (ctx.categoryPaths && ctx.categoryPaths.get(category.id)) || null,
      handle,
      variables: {
        input: compact({
          title,
          handle,
          descriptionHtml: category.description || null,
          image: category.image && category.image.src
            ? compact({ src: category.image.src, altText: category.image.alt || null })
            : null,
        }),
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* products                                                            */
/* ------------------------------------------------------------------ */

function inventory(item, ctx) {
  const tracked = Boolean(item.manage_stock);
  const weight = Number(item.weight);
  const unit = WEIGHT_UNITS[String(ctx.weightUnit || "kg").toLowerCase()] || "KILOGRAMS";

  const result = {
    inventoryPolicy: item.backorders && item.backorders !== "no" ? "CONTINUE" : "DENY",
    inventoryItem: compact({
      tracked,
      measurement: Number.isFinite(weight) && weight > 0 ? { weight: { value: weight, unit } } : null,
    }),
  };

  if (tracked && ctx.locationId && Number.isFinite(Number(item.stock_quantity))) {
    result.inventoryQuantities = [
      { locationId: ctx.locationId, name: "available", quantity: Math.max(0, Math.trunc(Number(item.stock_quantity))) },
    ];
  }
  return result;
}

function prices(item) {
  const regular = money(item.regular_price);
  const sale = money(item.sale_price);
  const price = sale || regular || money(item.price) || "0.00";
  return compact({
    price,
    compareAtPrice: sale && regular && Number(regular) > Number(sale) ? regular : null,
  });
}

/**
 * Variation attributes -> at most three Shopify options.
 * Returns { options: [{name, values}], extra } or { fail }.
 */
function productOptions(product, ctx) {
  const attributes = (product.attributes || []).filter((attribute) => attribute.variation);

  if (attributes.length <= MAX_OPTIONS) {
    return { options: attributes.map((a) => ({ name: decodeEntities(a.name), values: (a.options || []).map(decodeEntities) })) };
  }

  if (ctx.options.extra_attributes !== "merge") {
    return {
      fail: `Has ${attributes.length} attributes; Shopify allows ${MAX_OPTIONS} options`,
    };
  }

  // Merge everything after the second into one combined third option.
  const kept = attributes.slice(0, MAX_OPTIONS - 1);
  const merged = attributes.slice(MAX_OPTIONS - 1);
  return {
    options: [
      ...kept.map((a) => ({ name: decodeEntities(a.name), values: (a.options || []).map(decodeEntities) })),
      { name: merged.map((a) => decodeEntities(a.name)).join(" / "), values: [], merged: merged.map((a) => decodeEntities(a.name)) },
    ],
  };
}

/** The value a variation has for an option, "" meaning "any". */
function variationValue(variation, option) {
  if (option.merged) {
    return option.merged
      .map((name) => {
        const found = (variation.attributes || []).find((a) => decodeEntities(a.name) === name);
        return found ? decodeEntities(found.option) : "";
      })
      .join(" / ");
  }
  const found = (variation.attributes || []).find((a) => decodeEntities(a.name) === option.name);
  return found ? decodeEntities(found.option) : "";
}

function product(record, ctx) {
  const title = decodeEntities(record.name);
  if (!title) return fail("Product has no name");
  if (record.type === "grouped") return fail("Grouped product — Shopify has no equivalent");
  if (record.type === "external") return fail("External / affiliate product — Shopify has no equivalent");

  const handle = toHandle(record.slug || title);
  const status = ctx.options.product_status === "draft" || record.status !== "publish" ? "DRAFT" : "ACTIVE";
  const images = (record.images || []).filter((image) => image && image.src);
  const variantImages = new Set();

  let options;
  let variants;
  const children = [];

  if (record.type === "variable") {
    const resolved = productOptions(record, ctx);
    if (resolved.fail) return fail(resolved.fail);
    options = resolved.options;

    const rows = [];
    const seen = new Set();

    for (const variation of record.variations_data || []) {
      // A variation set to "Any Size" stands for every size: expand it.
      let combos = [[]];
      for (const option of options) {
        const value = variationValue(variation, option);
        const choices = value ? [value] : option.values.length ? option.values : ["Default"];
        combos = combos.flatMap((combo) => choices.map((choice) => [...combo, choice]));
      }

      combos.forEach((values, index) => {
        const key = values.join("\u0000");
        if (seen.has(key)) return;
        seen.add(key);
        options.forEach((option, i) => {
          if (!option.values.includes(values[i])) option.values.push(values[i]);
        });

        const image = variation.image && variation.image.src ? variation.image.src : null;
        if (image) variantImages.add(image);

        rows.push(
          compact({
            optionValues: options.map((option, i) => ({ optionName: option.name, name: values[i] })),
            sku: variation.sku || null,
            barcode: variation.global_unique_id || null,
            taxable: variation.tax_status !== "none",
            ...prices(variation),
            ...inventory(variation, ctx),
            file: image ? { originalSource: image, contentType: "IMAGE" } : null,
          })
        );
        children.push({
          entity: "variant",
          // An expanded "any" variation maps its first combination only.
          sourceId: index === 0 ? String(variation.id) : `${variation.id}:${index}`,
          match: { values, sku: variation.sku || null },
        });
      });
    }

    if (!rows.length) return fail("Variable product has no variations");
    if (rows.length > MAX_VARIANTS) return fail(`Has ${rows.length} variants; Shopify allows ${MAX_VARIANTS}`);
    variants = rows;
  } else {
    options = [{ name: "Title", values: ["Default Title"] }];
    variants = [
      compact({
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        sku: record.sku || null,
        barcode: record.global_unique_id || null,
        taxable: record.tax_status !== "none",
        ...prices(record),
        ...inventory(record, ctx),
      }),
    ];
    // An order line for a simple product names the product, not a variation.
    children.push({ entity: "variant", sourceId: `p${record.id}`, match: { values: ["Default Title"], sku: record.sku || null } });
  }

  const collections = (record.categories || [])
    .map((category) => ctx.idMap.get("collections", category.id))
    .filter(Boolean)
    .map((entry) => entry.gid);

  const input = compact({
    title,
    handle,
    descriptionHtml: record.description || record.short_description || null,
    status,
    productType: record.categories && record.categories[0] ? decodeEntities(record.categories[0].name) : null,
    tags: (record.tags || []).map((tag) => decodeEntities(tag.name)).filter(Boolean),
    productOptions: options.map((option) => ({
      name: option.name,
      values: option.values.map((value) => ({ name: value })),
    })),
    variants,
    files: images
      .filter((image) => !variantImages.has(image.src))
      .map((image) => compact({ originalSource: image.src, alt: image.alt || null, contentType: "IMAGE" })),
    collections,
  });

  return {
    line: {
      sourceId: String(record.id),
      name: title,
      hash: hashRecord(record),
      sourceUrl: pathOf(record.permalink),
      handle,
      skus: variants.map((variant) => variant.sku).filter(Boolean),
      variables: { input, synchronous: true },
      children,
    },
  };
}

/* ------------------------------------------------------------------ */
/* customers                                                           */
/* ------------------------------------------------------------------ */

function customer(record) {
  const email = cleanEmail(record.email || (record.billing && record.billing.email));
  const name = `Customer #${record.id}`;
  if (!email && !record.first_name && !record.last_name) return fail("Customer has no email or name");

  const billing = address({ ...record.billing, first_name: record.billing && record.billing.first_name || record.first_name, last_name: record.billing && record.billing.last_name || record.last_name });
  const shipping = address(record.shipping);
  const addresses = [billing, shipping].filter(Boolean).filter((item, index, list) => index === 0 || !sameAddress(item, list[0]));

  return {
    line: {
      sourceId: String(record.id),
      name,
      hash: hashRecord(record),
      email,
      variables: {
        input: compact({
          firstName: record.first_name || (record.billing && record.billing.first_name) || null,
          lastName: record.last_name || (record.billing && record.billing.last_name) || null,
          email,
          phone: e164(record.billing && record.billing.phone),
          tags: ["Migrated"],
          addresses,
        }),
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* orders                                                              */
/* ------------------------------------------------------------------ */

function moneySet(amount, currency) {
  return { shopMoney: { amount: money(amount) || "0.00", currencyCode: currency } };
}

function order(record, ctx) {
  const name = `Order #${record.number || record.id}`;
  const currency = String(record.currency || ctx.currency || "USD").toUpperCase();
  const items = record.line_items || [];
  if (!items.length) return fail("Order has no items");

  const lineItems = items.map((item) => {
    const variant =
      (item.variation_id && ctx.idMap.get("variant", item.variation_id)) ||
      ctx.idMap.get("variant", `p${item.product_id}`);
    const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1));
    const unit = Number(item.subtotal) / quantity;

    return compact({
      variantId: variant ? variant.gid : null,
      // Without a variant (product deleted, or not migrated) it becomes a
      // custom line with the original title and price.
      title: variant ? null : decodeEntities(item.name) || "Item",
      sku: variant ? null : item.sku || null,
      quantity,
      priceSet: moneySet(Number.isFinite(unit) ? unit : item.price, currency),
      requiresShipping: true,
      taxable: Number(item.total_tax) > 0,
    });
  });

  const map = (ctx.options.order_status_map || {})[record.status] || { payment: "PENDING", fulfilment: "UNFULFILLED" };
  const customerEntry = record.customer_id ? ctx.idMap.get("customers", record.customer_id) : null;

  const taxLines = (record.tax_lines || [])
    .map((tax) => ({
      title: String(tax.label || "Tax").slice(0, 255),
      rate: Number(tax.rate_percent || 0) / 100,
      priceSet: moneySet(Number(tax.tax_total || 0) + Number(tax.shipping_tax_total || 0), currency),
    }))
    .filter((tax) => Number(tax.priceSet.shopMoney.amount) > 0);

  const shippingLines = (record.shipping_lines || []).map((line) => ({
    title: decodeEntities(line.method_title) || "Shipping",
    priceSet: moneySet(line.total, currency),
  }));

  const discount = Number(record.discount_total);
  const coupon = (record.coupon_lines || [])[0];

  const orderInput = compact({
    name: ctx.options.keep_order_numbers ? `#${record.number || record.id}` : null,
    currency,
    processedAt: gmtIso(record.date_created_gmt) || gmtIso(record.date_created),
    email: customerEntry ? null : cleanEmail(record.billing && record.billing.email),
    customer: customerEntry ? { toAssociate: { id: customerEntry.gid } } : null,
    lineItems,
    billingAddress: address(record.billing),
    shippingAddress: address(record.shipping),
    shippingLines,
    taxLines,
    taxesIncluded: Boolean(record.prices_include_tax),
    discountCode: discount > 0
      ? { itemFixedDiscountCode: { code: String((coupon && coupon.code) || "DISCOUNT").slice(0, 255), amountSet: moneySet(discount, currency) } }
      : null,
    financialStatus: map.payment,
    fulfillmentStatus: map.fulfilment === "FULFILLED" ? "FULFILLED" : null,
    note: record.customer_note ? String(record.customer_note).slice(0, 5000) : null,
    tags: ["Migrated", `WooCommerce #${record.number || record.id}`],
  });

  const silent = ctx.options.silent_orders !== false;

  return {
    line: {
      sourceId: String(record.id),
      name,
      hash: hashRecord(record),
      variables: {
        order: orderInput,
        options: { sendReceipt: !silent, sendFulfillmentReceipt: !silent, inventoryBehaviour: "BYPASS" },
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* coupons                                                             */
/* ------------------------------------------------------------------ */

function coupon(record, ctx) {
  const code = String(record.code || "").trim().toUpperCase();
  if (!code) return fail("Coupon has no code");

  const amount = Number(record.amount) || 0;
  const startsAt = gmtIso(record.date_created_gmt) || new Date().toISOString();
  const endsAt = gmtIso(record.date_expires_gmt);
  if (endsAt && new Date(endsAt) < new Date()) return skip("Coupon has already expired");

  const minimum = money(record.minimum_amount);
  const common = compact({
    title: code,
    code,
    startsAt,
    endsAt,
    usageLimit: record.usage_limit ? Number(record.usage_limit) : null,
    appliesOncePerCustomer: Number(record.usage_limit_per_user) === 1,
    customerSelection: { all: true },
    minimumRequirement: minimum && Number(minimum) > 0
      ? { subtotal: { greaterThanOrEqualToSubtotal: minimum } }
      : null,
  });

  const base = { sourceId: String(record.id), name: code, hash: hashRecord(record) };

  if (record.free_shipping && amount === 0) {
    return { line: { ...base, kind: "free_shipping", variables: { freeShippingCodeDiscount: { ...common, destination: { all: true } } } } };
  }

  if (record.discount_type === "percent" && (amount <= 0 || amount > 100)) {
    return fail(`Percentage ${amount}% is not between 0 and 100`);
  }
  if (amount <= 0) return fail("Coupon has no discount amount");

  const productIds = (record.product_ids || [])
    .map((id) => ctx.idMap.get("products", id))
    .filter(Boolean)
    .map((entry) => entry.gid);

  const value = record.discount_type === "percent"
    ? { percentage: amount / 100 }
    : { discountAmount: { amount: money(amount), appliesOnEachItem: record.discount_type === "fixed_product" } };

  return {
    line: {
      ...base,
      kind: "basic",
      variables: {
        basicCodeDiscount: {
          ...common,
          customerGets: {
            value,
            items: productIds.length ? { products: { productsToAdd: productIds } } : { all: true },
          },
        },
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* pages and posts (WordPress API)                                     */
/* ------------------------------------------------------------------ */

function page(record, ctx) {
  const title = decodeEntities(record.title && record.title.rendered);
  if (!title) return fail("Page has no title");
  const handle = toHandle(record.slug || title);
  // WooCommerce's own pages make no sense in Shopify.
  if (["cart", "checkout", "my-account", "shop"].includes(record.slug)) {
    return skip("WooCommerce system page — Shopify has its own");
  }

  return {
    line: {
      sourceId: String(record.id),
      name: title,
      hash: hashRecord(record),
      sourceUrl: pathOf(record.link),
      handle,
      variables: {
        page: compact({
          title,
          handle,
          body: (record.content && record.content.rendered) || "",
          isPublished: ctx.options.page_status !== "hidden" && record.status === "publish",
        }),
      },
    },
  };
}

function post(record, ctx) {
  const title = decodeEntities(record.title && record.title.rendered);
  if (!title) return fail("Post has no title");
  if (!ctx.blog) return fail("No Shopify blog to put the post in");

  const handle = toHandle(record.slug || title);
  const embedded = record._embedded || {};
  const author = embedded.author && embedded.author[0] && embedded.author[0].name;
  const media = embedded["wp:featuredmedia"] && embedded["wp:featuredmedia"][0];
  const terms = (embedded["wp:term"] || []).flat().map((term) => decodeEntities(term.name)).filter(Boolean);

  return {
    line: {
      sourceId: String(record.id),
      name: title,
      hash: hashRecord(record),
      sourceUrl: pathOf(record.link),
      handle: `${ctx.blog.handle}/${handle}`,
      variables: {
        article: compact({
          blogId: ctx.blog.id,
          title,
          handle,
          body: (record.content && record.content.rendered) || "",
          summary: record.excerpt && record.excerpt.rendered ? record.excerpt.rendered : null,
          author: { name: decodeEntities(author) || "Staff" },
          tags: [...new Set(terms)].filter((term) => term !== "Uncategorized").slice(0, 250),
          isPublished: ctx.options.page_status !== "hidden" && record.status === "publish",
          publishDate: gmtIso(record.date_gmt),
          image: media && media.source_url ? compact({ url: media.source_url, altText: stripTags(media.alt_text) || null }) : null,
        }),
      },
    },
  };
}

module.exports = {
  prepare: { collections: prepareCollections },
  convert: {
    collections: collection,
    products: product,
    customers: customer,
    orders: order,
    coupons: coupon,
    pages: page,
    posts: post,
  },
};
