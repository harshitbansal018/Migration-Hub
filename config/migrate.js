// config/migrate.js
//
// Idempotent schema setup, applied on every boot so a fresh checkout and an
// existing database converge on the same shape.
//
// Order matters: a table has to exist before another table can point a foreign
// key at it. Creation runs parents-first, exactly as listed in runMigrations().
//
// To change an existing table, add a safeAlter() call rather than editing the
// CREATE statement -- CREATE TABLE IF NOT EXISTS does nothing to a database
// that already has the table.
const { query } = require("./db");

const DUPLICATE_COLUMN = "ER_DUP_FIELDNAME";
const DUPLICATE_KEY = "ER_DUP_KEYNAME";

async function safeAlter(label, sql) {
  try {
    await query(sql);
    console.log(`Migration applied: ${label}`);
  } catch (err) {
    if (err.code === DUPLICATE_COLUMN || err.code === DUPLICATE_KEY) {
      return; // already applied
    }
    console.error(`Migration failed (${label}):`, err.message);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* stores                                                              */
/* ------------------------------------------------------------------ */
const CREATE_STORES = `
  CREATE TABLE IF NOT EXISTS stores (
    id            INT AUTO_INCREMENT PRIMARY KEY,

    shop_domain   VARCHAR(255) NOT NULL,
    store_name    VARCHAR(255) DEFAULT NULL,
    email         VARCHAR(255) DEFAULT NULL,

    -- AES-256-GCM ciphertext, never plaintext. See utils/crypto.js.
    access_token  TEXT DEFAULT NULL,

    -- Shopify issues EXPIRING offline tokens; without these the app cannot
    -- refresh and every store breaks an hour after install.
    access_token_expires_at  DATETIME DEFAULT NULL,
    refresh_token            TEXT DEFAULT NULL,
    refresh_token_expires_at DATETIME DEFAULT NULL,

    api_version   VARCHAR(16) NOT NULL DEFAULT '2025-01',
    currency      VARCHAR(8) DEFAULT NULL,

    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    installed_at  DATETIME DEFAULT NULL,
    uninstalled_at DATETIME DEFAULT NULL,

    -- NULL means the app still opens on the setup screen. A date means it
    -- opens on the dashboard, whether setup was finished or skipped.
    onboarded_at  TIMESTAMP NULL DEFAULT NULL,

    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_shop_domain (shop_domain)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* faqs                                                                */
/* ------------------------------------------------------------------ */
const CREATE_FAQS = `
  CREATE TABLE IF NOT EXISTS faqs (
    id   INT AUTO_INCREMENT PRIMARY KEY,

    question VARCHAR(512) NOT NULL,
    -- TEXT, not VARCHAR: being truncated mid-sentence is the one failure a
    -- help page cannot afford.
    answer   TEXT NOT NULL,

    -- Counted in tens by the seed, so a question can be slipped between two
    -- others without renumbering everything after it.
    position INT NOT NULL DEFAULT 0,

    -- Hidden rather than deleted: a question being reworked should stop
    -- showing without losing the text it had.
    is_active TINYINT(1) NOT NULL DEFAULT 1,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    KEY idx_faqs_active (is_active, position)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* plans and billing                                                   */
/* ------------------------------------------------------------------ */
const CREATE_PLANS = `
  CREATE TABLE IF NOT EXISTS plans (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    price         DOUBLE NOT NULL DEFAULT 0,
    is_popular    TINYINT(1) NULL DEFAULT 0,
    is_active     TINYINT(1) NULL DEFAULT 1,
    days          INT NULL,
    -- The card's lines, as a JSON list of strings.
    plan_content  LONGTEXT NULL,
    created_at    DATETIME NULL,
    updated_at    DATETIME NULL,
    UNIQUE KEY uniq_plan_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// Shops listed here (status 1) get Shopify TEST charges: no money moves.
const CREATE_DUMMY_SHOPS = `
  CREATE TABLE IF NOT EXISTS dummy_shops (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    shop_name VARCHAR(255) NULL,
    status    TINYINT(1) NULL DEFAULT 1,
    KEY idx_dummy_shop_active (shop_name, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// user_id is the store id. status 1 = the active plan, 0 = past or pending.
const CREATE_USER_MEMBERSHIPS = `
  CREATE TABLE IF NOT EXISTS user_memberships (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    user_id       INT NULL,
    membership_id INT NULL,
    created_at    DATETIME NULL,
    updated_at    DATETIME NULL,
    status        TINYINT(1) NULL DEFAULT 1,
    KEY idx_membership_store (user_id, status),
    CONSTRAINT fk_membership_store FOREIGN KEY (user_id)
      REFERENCES stores(id) ON DELETE CASCADE,
    CONSTRAINT fk_membership_plan FOREIGN KEY (membership_id)
      REFERENCES plans(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// status: 1 = waiting for approval, 2 = paid/active, 0 = declined.
const CREATE_MEMBERSHIP_PAYMENTS = `
  CREATE TABLE IF NOT EXISTS membership_payments (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    membership_id INT NULL,
    user_id       INT NULL,
    api_client_id BIGINT NULL,
    charge_id     BIGINT NULL,
    date_add      DATETIME NULL,
    date_update   DATETIME NULL,
    status        INT NULL,
    KEY idx_payment_membership (membership_id),
    KEY idx_payment_store (user_id),
    CONSTRAINT fk_payment_membership FOREIGN KEY (membership_id)
      REFERENCES user_memberships(id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_store FOREIGN KEY (user_id)
      REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/** Plan limits. NULL means unlimited / every data type. */
async function addPlanLimitColumns() {
  await safeAlter("plans.max_records", "ALTER TABLE plans ADD COLUMN max_records INT NULL DEFAULT NULL");
  await safeAlter("plans.max_migrations", "ALTER TABLE plans ADD COLUMN max_migrations INT NULL DEFAULT NULL");
  await safeAlter("plans.allowed_entities", "ALTER TABLE plans ADD COLUMN allowed_entities JSON NULL DEFAULT NULL");
}

/* ------------------------------------------------------------------ */
/* migration                                                           */
/* ------------------------------------------------------------------ */

// The merchant's old store. Keys are AES-256-GCM encrypted (utils/crypto.js)
// and never sent back to the browser; credentials_hint is what the screen shows.
const CREATE_SOURCE_CONNECTIONS = `
  CREATE TABLE IF NOT EXISTS source_connections (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    store_id         INT NOT NULL,
    platform         ENUM('woocommerce','wordpress','csv','magento','bigcommerce') NOT NULL,
    base_url         VARCHAR(255) NOT NULL,
    credentials      TEXT NULL,
    credentials_hint VARCHAR(64) NULL,
    status           ENUM('connected','failed','disconnected') NOT NULL DEFAULT 'connected',
    last_error       VARCHAR(512) NULL,
    source_version   VARCHAR(64) NULL,
    -- {"products":1240,"customers":800,...} from the last scan
    scan_counts      JSON NULL,
    last_tested_at   DATETIME NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_conn_store (store_id, status),
    CONSTRAINT fk_conn_store FOREIGN KEY (store_id)
      REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// One migration run. A draft is the wizard in progress; worker_id/locked_at
// make sure only one worker processes a run, and a stale lock lets another
// worker resume it after a crash.
const CREATE_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS migrations (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    store_id             INT NOT NULL,
    source_connection_id INT NULL,
    type                 ENUM('demo','full','delta','retry') NOT NULL DEFAULT 'full',
    status               ENUM('draft','queued','running','paused','completed','failed','cancelled')
                         NOT NULL DEFAULT 'draft',
    wizard_step          TINYINT NOT NULL DEFAULT 1,
    -- ["products","customers","orders"]
    entities             JSON NULL,
    -- every choice from the wizard's Options step
    options              JSON NULL,
    total_records        INT NOT NULL DEFAULT 0,
    -- the run a retry or delta run came from
    parent_migration_id  INT NULL,
    worker_id            VARCHAR(64) NULL,
    locked_at            DATETIME NULL,
    last_error           VARCHAR(512) NULL,
    started_at           DATETIME NULL,
    finished_at          DATETIME NULL,
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_mig_store_status (store_id, status),
    KEY idx_mig_work (status, locked_at),
    CONSTRAINT fk_mig_store FOREIGN KEY (store_id)
      REFERENCES stores(id) ON DELETE CASCADE,
    CONSTRAINT fk_mig_conn FOREIGN KEY (source_connection_id)
      REFERENCES source_connections(id) ON DELETE CASCADE,
    CONSTRAINT fk_mig_parent FOREIGN KEY (parent_migration_id)
      REFERENCES migrations(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// Progress per data type within a run: drives the progress bars and the
// dashboard cards. source_cursor is where to continue in the source after a
// pause or restart ("cursor" itself is a reserved word in MySQL).
const CREATE_MIGRATION_STEPS = `
  CREATE TABLE IF NOT EXISTS migration_steps (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    migration_id  INT NOT NULL,
    entity        VARCHAR(32) NOT NULL,
    -- run order: collections, products, customers, orders, coupons, pages, posts, redirects
    position      TINYINT NOT NULL,
    status        ENUM('pending','running','done','failed','skipped') NOT NULL DEFAULT 'pending',
    total         INT NOT NULL DEFAULT 0,
    processed     INT NOT NULL DEFAULT 0,
    succeeded     INT NOT NULL DEFAULT 0,
    failed        INT NOT NULL DEFAULT 0,
    skipped       INT NOT NULL DEFAULT 0,
    source_cursor VARCHAR(255) NULL,
    started_at    DATETIME NULL,
    finished_at   DATETIME NULL,
    UNIQUE KEY uniq_step (migration_id, entity),
    CONSTRAINT fk_step_mig FOREIGN KEY (migration_id)
      REFERENCES migrations(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// Source record -> Shopify record. Stops duplicates, links orders to their
// products and customers, makes resume and delta runs possible, and lets demo
// data be deleted (migration_id). Keyed on the connection, not the run, so a
// later run finds what an earlier one created.
const CREATE_ID_MAP = `
  CREATE TABLE IF NOT EXISTS id_map (
    id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
    store_id             INT NOT NULL,
    source_connection_id INT NOT NULL,
    entity               VARCHAR(32) NOT NULL,
    source_id            VARCHAR(64) NOT NULL,
    -- old permalink, the source of a 301 redirect
    source_url           VARCHAR(512) NULL,
    shopify_gid          VARCHAR(128) NOT NULL,
    -- new handle, the target of the redirect
    shopify_handle       VARCHAR(255) NULL,
    -- SHA-1 of the source record: a delta run updates only what changed
    source_hash          CHAR(40) NULL,
    migration_id         INT NULL,
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_map (source_connection_id, entity, source_id),
    KEY idx_map_migration (migration_id),
    KEY idx_map_gid (shopify_gid),
    CONSTRAINT fk_map_store FOREIGN KEY (store_id)
      REFERENCES stores(id) ON DELETE CASCADE,
    CONSTRAINT fk_map_conn FOREIGN KEY (source_connection_id)
      REFERENCES source_connections(id) ON DELETE CASCADE,
    CONSTRAINT fk_map_mig FOREIGN KEY (migration_id)
      REFERENCES migrations(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// migration_errors and migration_logs are gone: a run's failures live in its
// errors.csv and its timeline in log.txt, inside the run's private storage
// folder (services/migration/storage.js). The database keeps only the counts.
// A database created before this keeps the two, now unused, tables; drop them
// by hand when convenient.

/**
 * Columns the file-based design adds. Safe on every boot.
 *
 *   storage_path              the run's private folder under storage/
 *   phase                     export / convert / import / done
 *   personal_files_expire_at  customer and order files deleted (finish + 30 days)
 *   files_expire_at           the whole folder deleted (finish + 90 days)
 *   files_deleted_at          when the folder actually went
 *
 * Per step: how many records passed each phase, where to carry on after a
 * restart, and Shopify's job id while Shopify runs a bulk import.
 */
async function addFileDesignColumns() {
  const alters = [
    ["migrations.storage_path", "ALTER TABLE migrations ADD COLUMN storage_path VARCHAR(512) NULL"],
    ["migrations.phase", "ALTER TABLE migrations ADD COLUMN phase ENUM('export','convert','import','done') NULL"],
    ["migrations.personal_files_expire_at", "ALTER TABLE migrations ADD COLUMN personal_files_expire_at DATETIME NULL"],
    ["migrations.files_expire_at", "ALTER TABLE migrations ADD COLUMN files_expire_at DATETIME NULL"],
    ["migrations.files_deleted_at", "ALTER TABLE migrations ADD COLUMN files_deleted_at DATETIME NULL"],
    ["migrations.personal_files_deleted_at", "ALTER TABLE migrations ADD COLUMN personal_files_deleted_at DATETIME NULL"],
    ["migrations.idx_mig_expiry", "ALTER TABLE migrations ADD KEY idx_mig_expiry (files_deleted_at, files_expire_at)"],
    ["migration_steps.phase", "ALTER TABLE migration_steps ADD COLUMN phase ENUM('export','convert','import','done') NULL"],
    ["migration_steps.exported", "ALTER TABLE migration_steps ADD COLUMN exported INT NOT NULL DEFAULT 0"],
    ["migration_steps.imported", "ALTER TABLE migration_steps ADD COLUMN imported INT NOT NULL DEFAULT 0"],
    ["migration_steps.export_page", "ALTER TABLE migration_steps ADD COLUMN export_page INT NOT NULL DEFAULT 0"],
    ["migration_steps.import_line", "ALTER TABLE migration_steps ADD COLUMN import_line INT NOT NULL DEFAULT 0"],
    ["migration_steps.bulk_operation_id", "ALTER TABLE migration_steps ADD COLUMN bulk_operation_id VARCHAR(128) NULL"],
  ];

  for (const [label, sql] of alters) await safeAlter(label, sql);
}

/*
 * The plans. Edit here and restart: this runs on every boot and writes these
 * values into the `plans` table.
 *
 *   price       USD per 30-day billing month.
 *   popular     true on ONE plan: its card gets the "Popular" badge.
 *   maxRecords  full-migration records per calendar month. null = unlimited.
 *               0 = demo only (the free demo never counts against a plan).
 *   allowed     data types the plan may migrate; null = all of them. The
 *               pseudo-type "delta" unlocks "Migrate recent data".
 *   lines       what the card lists.
 *
 * The name is how a plan is found in the database: renaming one creates a new
 * plan and leaves the old one on sale. Removing a line does not remove a plan.
 */
const PLANS = [
  {
    name: "Free", price: 0, popular: false, maxRecords: 0, allowed: null,
    lines: ["Free demo — 20 of each data type", "Check results in Shopify first", "Community support"],
  },
  {
    name: "Starter", price: 19, popular: false, maxRecords: 2000,
    allowed: ["collections", "products", "customers", "redirects"],
    lines: ["2,000 records / month", "Products, collections, customers", "301 redirects", "Email support"],
  },
  {
    name: "Pro", price: 49, popular: true, maxRecords: 25000, allowed: null,
    lines: ["25,000 records / month", "All data — orders, coupons, blog", "301 redirects", "Migrate recent data"],
  },
  {
    name: "Unlimited", price: 99, popular: false, maxRecords: null, allowed: null,
    lines: ["Unlimited records", "All data, redirects, recent data", "Migration assistance"],
  },
];

async function seedPlans() {
  for (const plan of PLANS) {
    await query(
      `INSERT INTO plans
        (name, price, is_popular, is_active, days, plan_content,
         max_records, max_migrations, allowed_entities, created_at, updated_at)
       VALUES (?, ?, ?, 1, 30, ?, ?, NULL, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         price = VALUES(price), is_popular = VALUES(is_popular), is_active = 1,
         days = VALUES(days), plan_content = VALUES(plan_content),
         max_records = VALUES(max_records),
         allowed_entities = VALUES(allowed_entities),
         updated_at = NOW()`,
      [
        plan.name,
        plan.price,
        plan.popular ? 1 : 0,
        JSON.stringify(plan.lines || []),
        plan.maxRecords,
        plan.allowed ? JSON.stringify(plan.allowed) : null,
      ]
    );
  }
}

/**
 * Seed the Help screen's FAQ. Any default question not in the table yet is
 * added at the end, so new questions reach installs that were seeded before.
 * To take one down, set is_active = 0 rather than deleting the row, or the
 * next boot adds it back.
 */
async function seedFaqs() {
  // Required here, not at the top: this is the only thing in the migration
  // that needs it, and it keeps the schema file free of app imports.
  const { DEFAULT_FAQ } = require("../controllers/helpController");

  if (!DEFAULT_FAQ.length) return;

  const existing = await query("SELECT question, position FROM faqs");
  const have = new Set(existing.map((row) => row.question));
  let position = existing.reduce((max, row) => Math.max(max, Number(row.position) || 0), 0);

  // position in tens, so a question can be slipped between two others
  // without renumbering the rest.
  const values = DEFAULT_FAQ.filter((item) => !have.has(item.question)).map((item) => {
    position += 10;
    return [item.question, item.answer, position];
  });

  if (!values.length) return;

  await query("INSERT INTO faqs (question, answer, position) VALUES ?", [values]);

  console.log(`Migration: seeded ${values.length} FAQ entries`);
}

async function runMigrations() {
  // Parents before children -- a foreign key needs its target to exist.
  await query(CREATE_STORES);
  await query(CREATE_DUMMY_SHOPS);
  await query(CREATE_PLANS);
  await query(CREATE_USER_MEMBERSHIPS);
  await query(CREATE_MEMBERSHIP_PAYMENTS);
  await addPlanLimitColumns();
  await seedPlans();
  await query(CREATE_FAQS);
  await seedFaqs();
  // After stores: every migration table points back at it.
  await query(CREATE_SOURCE_CONNECTIONS);
  await query(CREATE_MIGRATIONS);
  await query(CREATE_MIGRATION_STEPS);
  await query(CREATE_ID_MAP);
  await addFileDesignColumns();
}

module.exports = { runMigrations, safeAlter, PLANS };
