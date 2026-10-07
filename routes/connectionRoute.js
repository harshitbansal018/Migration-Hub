const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const connection = require("../controllers/connectionController");

router.use(requireSession);

router.get("/", connection.list);
router.post("/:id/disconnect", connection.disconnect);

module.exports = router;
