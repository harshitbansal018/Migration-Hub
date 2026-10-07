// controllers/helpController.js
//
// Help & support: installation steps, how to create API keys, and the FAQ.
//
// The steps and key guides live here rather than in the template so a test
// can prove they are all present. The FAQ shown on screen comes from the
// `faqs` table (support can edit it without a deploy); DEFAULT_FAQ only seeds
// it. Keep all of it describing what the app REALLY does.
const faqModel = require("../models/faqModel");

const INSTALL_STEPS = [
  {
    title: "Add the app from the Shopify App Store",
    detail: "Approve the permissions Shopify lists. Nothing in your new store changes at this point.",
  },
  {
    title: "Create read-only API keys in your old store",
    detail: "WooCommerce: a REST API key with Read permission. See the API keys tab for each step.",
    path: ["WooCommerce", "Settings", "Advanced", "REST API", "Add key", "Permissions: Read"],
  },
  {
    title: "Connect and run a free demo",
    detail: "The demo moves 20 of each kind of data. Check them in your Shopify admin before the full migration — and delete them with one click if you want to start clean.",
  },
  {
    title: "Begin the full migration",
    detail: "It runs on our server, so you can close the browser. Then review the results and retry anything that failed.",
  },
];

const KEY_GUIDES = [
  {
    platform: "WooCommerce",
    logo: "woocommerce",
    steps: [
      "In your WordPress admin, open WooCommerce → Settings → Advanced → REST API.",
      "Press Add key. Description: “Shopify migration”. User: an administrator.",
      "Set Permissions to Read — we never need to write to your old store.",
      "Press Generate API key, then copy the Consumer key (ck_…) and Consumer secret (cs_…).",
      "Paste both into the Connect step of a new migration. The secret is shown only once by WooCommerce, so copy it now.",
    ],
    note: "Your store must use https://. If “REST API” returns 404, set Settings → Permalinks to anything except “Plain”.",
  },
  {
    platform: "WordPress",
    logo: "wordpress",
    steps: [
      "Published pages and posts are public, so for those no keys are needed — leave the fields empty.",
      "To include drafts too: Users → Profile → Application Passwords.",
      "Name it “Shopify migration” and press Add New Application Password.",
      "Enter your WordPress username and the generated password in the Connect step.",
    ],
    note: "Security plugins sometimes block the REST API. If the test fails, allow /wp-json/ for our requests.",
  },
];

const DEFAULT_FAQ = [
  {
    question: "Will the migration change or delete anything in my old store?",
    answer: "No. We only ask for read-only keys and only read from your old store. It keeps working exactly as before until you switch your domain to Shopify.",
  },
  {
    question: "Can I close the browser while it runs?",
    answer: "Yes. The migration runs on our server in the background. Come back any time to watch the progress — you also get an email when it finishes.",
  },
  {
    question: "What happens if I run a migration twice?",
    answer: "Nothing is duplicated. We remember every record we moved (old ID → new Shopify ID), so a second run skips what is already in Shopify. “Migrate recent data” uses the same memory to move only new or changed records.",
  },
  {
    question: "Why did some products fail?",
    answer: "Usually because Shopify has no equivalent: grouped products, more than 3 attributes (Shopify allows 3 options), or an image address that no longer works. The results screen lists every one with the reason; fix them in your old store and press “Retry failed”.",
  },
  {
    question: "Do my customers get emails?",
    answer: "Only if you choose “Send account invite emails”. Imported orders never email customers unless you untick “Do not email customers about imported orders”.",
  },
  {
    question: "Will my Google rankings survive the move?",
    answer: "Tick “301 Redirects” and every old product, category, page and post address is redirected to its new Shopify address, so links and search results keep working.",
  },
  {
    question: "What do you keep, and for how long?",
    answer: "Your data passes through our server in encrypted files: customer and order files are deleted after 30 days, everything else after 90. Our database keeps only status, counters and ID pairs — never names, emails or addresses. You can delete a migration's files immediately from its results screen.",
  },
  {
    question: "How am I billed?",
    answer: "Through Shopify. A paid plan is a recurring Shopify app charge that you approve in your admin, and it appears on your Shopify invoice. The free demo never counts against your plan.",
  },
];

function tabFrom(query) {
  const tab = (query || {}).tab;
  return ["install", "keys", "faq"].includes(tab) ? tab : "install";
}

exports.getHelp = async (req, res) => {
  try {
    const tab = tabFrom(req.query);
    const faq = tab === "faq" ? await faqModel.listActive() : [];

    res.render("help", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      tab,
      steps: INSTALL_STEPS,
      guides: KEY_GUIDES,
      faq,
      supportEmail: process.env.SUPPORT_EMAIL || null,
    });
  } catch (err) {
    console.error("Help screen failed:", err.message);
    res.status(500).send("Error loading help");
  }
};

exports.INSTALL_STEPS = INSTALL_STEPS;
exports.KEY_GUIDES = KEY_GUIDES;
exports.tabFrom = tabFrom;
exports.DEFAULT_FAQ = DEFAULT_FAQ;
