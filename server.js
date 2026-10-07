require("dotenv").config();

const express = require("express");
const path = require("path");

const { ensureDatabase, assertConnection } = require("./config/db");
const { runMigrations } = require("./config/migrate");
const { frameAncestors, noStore } = require("./middleware/security");
const { serializeForScript } = require("./utils/html");
const { shopifyAdminUrl } = require("./utils/shop");
const viewHelpers = require("./utils/viewHelpers");
const { createWorker } = require("./services/migration/worker");

const authRoutes = require("./routes/authRoute");
const helpRoutes = require("./routes/helpRoute");
const dashboardRoutes = require("./routes/dashboardRoute");
const setupRoutes = require("./routes/setupRoute");
const planRoutes = require("./routes/planRoute");
const migrationRoutes = require("./routes/migrationRoute");
const connectionRoutes = require("./routes/connectionRoute");
const webhookRoutes = require("./routes/webhookRoute");

const REQUIRED_ENV = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "HOST",
  "TOKEN_ENCRYPTION_KEY",
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(", ")}`
  );
  process.exit(1);
}

const app = express();

// Behind a tunnel/proxy, trust the forwarded protocol so req.protocol is https.
app.set("trust proxy", 1);

/* ---------------- WEBHOOKS ----------------
   Mounted before the JSON body parser: HMAC verification needs the raw body. */
app.use("/webhooks", webhookRoutes);

/* ---------------- PARSERS ---------------- */
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

/* ---------------- VIEW ENGINE ---------------- */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// <%- json(value) %> embeds data in a <script> block without letting a stray
// </script> in the data break out of it.
app.locals.json = serializeForScript;
app.locals.shopifyAdminUrl = shopifyAdminUrl;
// <%= h.number(n) %>, h.shortDate(d), h.status(s)... -- see utils/viewHelpers.js
app.locals.h = viewHelpers;

/* ---------------- SECURITY HEADERS ----------------
   Required for the app to render inside the Shopify admin iframe. */
app.use(frameAncestors);

/* ---------------- STATIC ---------------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- NO CACHING OF SCREENS ----------------
   After express.static, so CSS and JS still cache normally. */
app.use(noStore);

/* ---------------- ROUTES ----------------
   Add feature routes here, e.g.:
     app.use("/widgets", require("./routes/widgetRoute"));
   Mount them ABOVE dashboardRoutes, which owns "/". */
app.use("/api/auth", authRoutes);
app.use("/help", helpRoutes);
app.use("/plans", planRoutes);
app.use("/migrations", migrationRoutes);
app.use("/connections", connectionRoutes);
app.use("/", setupRoutes);
app.use("/", dashboardRoutes);

/* ---------------- ERROR HANDLING ---------------- */
app.use((req, res) => {
  res.status(404).send("Not found");
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = err.statusCode || 500;

  // Never leak an internal message or stack trace to a merchant's browser.
  const message = status < 500 ? err.message : "Something went wrong";

  console.error("Unhandled error:", err.stack || err.message);

  if (String(req.headers.accept || "").includes("text/html")) {
    return res.status(status).send(message);
  }

  return res.status(status).json({ error: message });
});

/* ---------------- START ---------------- */
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await ensureDatabase();
    await assertConnection();
    await runMigrations();
  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  /* ---------------- MIGRATION WORKER ----------------
     Production runs the worker as its own program (npm run worker) so a big
     migration never slows these screens. For development it runs in here
     too, unless RUN_WORKER_IN_WEB=false. */
  const inProcess = process.env.RUN_WORKER_IN_WEB
    ? process.env.RUN_WORKER_IN_WEB === "true"
    : process.env.NODE_ENV !== "production";

  if (inProcess) {
    const worker = createWorker({ name: "web-worker" });
    worker.start();

    const shutdown = async () => {
      await worker.stop();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
})();
