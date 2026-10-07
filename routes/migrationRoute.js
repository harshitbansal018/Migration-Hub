const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const migration = require("../controllers/migrationController");

router.use(requireSession);

router.get("/", migration.list);
router.post("/new", migration.create);
router.post("/demo", migration.quickDemo);

router.get("/:id", migration.show);
router.get("/:id/status", migration.status);
router.get("/:id/errors.csv", migration.errorsCsv);

router.post("/:id/wizard", migration.saveStep);
router.post("/:id/connect", migration.testConnection);
router.post("/:id/begin", migration.begin);
router.post("/:id/discard", migration.discard);
router.post("/:id/control", migration.control);
router.post("/:id/retry", migration.retry);
router.post("/:id/delta", migration.delta);
router.post("/:id/demo-cleanup", migration.deleteDemoData);
router.post("/:id/delete-files", migration.deleteFiles);

module.exports = router;
