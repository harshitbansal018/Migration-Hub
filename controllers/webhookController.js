// controllers/webhookController.js
//
// Every handler here runs behind middleware/verifyWebhook, so the request is
// proven to come from Shopify before any of this executes. Handlers reply 200
// first and do their bookkeeping afterwards -- Shopify retries on anything
// that is slow or non-200.
const storeModel = require("../models/storeModel");
const { normalizeShopDomain } = require("../utils/shop");
const migrationModel = require("../models/migrationModel");
const storage = require("../services/migration/storage");

/* ===================== app/uninstalled ===================== */

exports.appUninstalled = async (req, res) => {
  const shop = normalizeShopDomain(req.webhookShop);

  // Acknowledge first; Shopify does not care about our bookkeeping.
  res.status(200).send("OK");

  if (!shop) {
    console.warn("Uninstall webhook had no usable shop domain");
    return;
  }

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) {
      console.log("Uninstall webhook for unknown shop:", shop);
      return;
    }

    // Deactivates, stamps uninstalled_at and drops the revoked tokens. The
    // row is kept so a reinstall resumes rather than starting over.
    await storeModel.markUninstalled(shop);

    console.log("App uninstalled for", shop);
  } catch (err) {
    console.error("Uninstall webhook processing failed:", err.message);
  }
};

/* ===================== privacy (mandatory) ===================== */

/**
 * A customer has asked for the data this app holds about them.
 *
 * The database holds none (only old-ID <-> Shopify-ID pairs). Their details
 * exist only inside a migration's encrypted customer and order files, which
 * are deleted 30 days after the migration -- and immediately on redact.
 */
exports.customersDataRequest = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const customerId = payload.customer && payload.customer.id;

  if (!shop || !customerId) return;

  console.log(
    `customers/data_request for ${shop}: customer ${customerId} -- database holds no customer data`
  );
};

/**
 * A customer has asked to be erased. Their details can only be in the shop's
 * migration files, so every customer and order file of that shop goes now --
 * without waiting for the 30-day deletion.
 */
exports.customersRedact = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const customerId = payload.customer && payload.customer.id;

  if (!shop || !customerId) return;

  try {
    const store = await storeModel.findByDomain(shop);
    if (!store) return;

    for (const row of await migrationModel.storagePathsForStore(store.id)) {
      await storage.deletePersonalFiles(row.storage_path);
      await migrationModel.markPersonalDeleted(row.id);
    }
    console.log(`customers/redact for ${shop}: customer and order files deleted`);
  } catch (err) {
    console.error("customers/redact processing failed:", err.message);
  }
};

exports.shopRedact = async (req, res) => {
  const shop = normalizeShopDomain(req.webhookShop);

  res.status(200).send("OK");

  if (!shop) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    // Files first: once the rows are gone nothing points at the folders.
    await storage.deleteShopFolders(shop);

    // Every dependent table is ON DELETE CASCADE, so this clears the store's
    // memberships, payments, connections, migrations, steps and id_map too.
    await storeModel.deleteStore(shop);

    console.log("shop/redact completed for", shop);
  } catch (err) {
    console.error("shop/redact processing failed:", err.message);
  }
};
