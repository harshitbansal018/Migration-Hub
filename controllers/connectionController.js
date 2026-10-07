// controllers/connectionController.js
//
// "Manage connection": the old stores this shop has connected, and
// Disconnect -- which removes the keys and, by the foreign keys, every
// migration and id_map row of that connection.
const sourceConnectionModel = require("../models/sourceConnectionModel");
const migrationModel = require("../models/migrationModel");
const storage = require("../services/migration/storage");

exports.list = async (req, res) => {
  try {
    const connections = await sourceConnectionModel.listForStore(req.storeId);
    res.render("connections", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      connections,
    });
  } catch (err) {
    console.error("Connections screen failed:", err.message);
    res.status(500).send("Error loading connections");
  }
};

exports.disconnect = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const connection = Number.isInteger(id) ? await sourceConnectionModel.findForStore(req.storeId, id) : null;
    if (!connection) return res.status(404).json({ error: "Connection not found." });

    const active = await migrationModel.activeForStore(req.storeId);
    if (active && active.source_connection_id === id) {
      return res.status(409).json({ error: "A migration from this store is still running. Cancel it first." });
    }

    // The folders go too: the rows that point at them are about to vanish.
    const migrations = await migrationModel.listForStore(req.storeId, { limit: 10000 });
    for (const migration of migrations.filter((m) => m.source_connection_id === id && m.storage_path)) {
      await storage.deleteFolder(migration.storage_path).catch(() => {});
    }

    await sourceConnectionModel.remove(req.storeId, id);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Disconnect failed:", err.message);
    return res.status(500).json({ error: "Could not disconnect." });
  }
};
