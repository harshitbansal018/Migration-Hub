const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const { getHelp } = require("../controllers/helpController");

// Behind a verified session token like every other screen.
router.use(requireSession);

router.get("/", getHelp);

module.exports = router;
