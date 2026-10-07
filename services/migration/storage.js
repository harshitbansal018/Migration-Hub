// services/migration/storage.js
//
// Every byte of a shop's data that touches our server goes through here.
//
// A migration gets its own private folder:
//
//   storage/migrations/{platform}/{shop domain}/{migration id}/
//     export/  products.part-0001.jsonl.gz.enc   raw, as the old store sent it
//     import/  products.jsonl.enc                converted, ready for Shopify
//     errors.csv                                 what failed and why (no personal data)
//     log.txt                                    timeline, for support
//
// Rules, all enforced here rather than trusted to callers:
//   - storage/ is outside public/, so nothing in it has a web address.
//   - Data files are AES-256-GCM encrypted; GCM authenticates them, so a
//     tampered file fails to read instead of returning garbage.
//   - Files are written and read ONE LINE AT A TIME, so a 2 GB file uses the
//     memory of a 2 MB one.
//   - A file is written to .tmp and renamed when complete: a crash never
//     leaves a half-written file that looks finished.
//
// File layout:  "MGF1" | iv (12) | ciphertext ... | auth tag (16)
// The ciphertext is of gzip(jsonl) for *.gz.enc and of plain jsonl otherwise.
//
// When the app runs on more than one server, this file is the only thing
// that changes to move the same layout onto S3 / R2.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const readline = require("readline");

const { BY_KEY, MIN_FREE_DISK_MB } = require("./constants");

const MAGIC = Buffer.from("MGF1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

const APP_ROOT = path.join(__dirname, "..", "..");
const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR || path.join(APP_ROOT, "storage"));

/* ------------------------------------------------------------------ */
/* key                                                                 */
/* ------------------------------------------------------------------ */

let cachedKey = null;

/**
 * FILE_ENCRYPTION_KEY when set (32 bytes, hex or base64). Otherwise a key
 * DERIVED from TOKEN_ENCRYPTION_KEY with HKDF, so the token key itself is
 * never used for two jobs. Either way it lives only in the server's .env.
 */
function fileKey() {
  if (cachedKey) return cachedKey;

  const decode = (raw) =>
    /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");

  const own = String(process.env.FILE_ENCRYPTION_KEY || "").trim();
  if (own) {
    const key = decode(own);
    if (key.length !== 32) throw new Error("FILE_ENCRYPTION_KEY must decode to 32 bytes");
    cachedKey = key;
    return key;
  }

  const base = String(process.env.TOKEN_ENCRYPTION_KEY || "").trim();
  if (!base) throw new Error("TOKEN_ENCRYPTION_KEY is not set; migration files cannot be encrypted");

  cachedKey = Buffer.from(
    crypto.hkdfSync("sha256", decode(base), Buffer.alloc(0), "migration-files-v1", 32)
  );
  return cachedKey;
}

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

/** A folder-safe name. Shop domains already are; this is belt and braces. */
function safeSegment(value) {
  const text = String(value || "").toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  if (!text || text === "." || text === "..") throw new Error(`Unsafe path segment: ${value}`);
  return text;
}

/** What is saved in migrations.storage_path, e.g. storage/migrations/woocommerce/x.myshopify.com/7 */
function storagePathFor(platform, shopDomain, migrationId) {
  return [
    "storage",
    "migrations",
    safeSegment(platform),
    safeSegment(shopDomain),
    safeSegment(String(migrationId)),
  ].join("/");
}

/** The absolute folder for a stored path. Refuses anything outside storage/. */
function resolveDir(storagePath) {
  const relative = String(storagePath || "").replace(/^storage\//, "");
  const absolute = path.resolve(STORAGE_ROOT, relative);

  if (!relative || !absolute.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error(`Refusing storage path outside storage/: ${storagePath}`);
  }
  return absolute;
}

async function ensureDir(storagePath) {
  const dir = resolveDir(storagePath);
  await fsp.mkdir(path.join(dir, "export"), { recursive: true });
  await fsp.mkdir(path.join(dir, "import"), { recursive: true });
  return dir;
}

const exportPartName = (entity, part) =>
  `export/${entity}.part-${String(part).padStart(6, "0")}.jsonl.gz.enc`;
const importFileName = (entity) => `import/${entity}.jsonl.enc`;

/* ------------------------------------------------------------------ */
/* encrypted JSONL                                                     */
/* ------------------------------------------------------------------ */

/**
 * Open an encrypted JSONL file for writing.
 *
 *   const out = await openWriter(file, { gzip: true });
 *   await out.write({ id: 1 });
 *   await out.close();      // only now does the file appear under its name
 *   await out.abort();      // or throw it away
 */
async function openWriter(file, { gzip = false } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });

  const tmp = `${file}.tmp`;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", fileKey(), iv);
  const out = fs.createWriteStream(tmp);
  const source = gzip ? zlib.createGzip() : cipher;

  out.write(Buffer.concat([MAGIC, iv]));
  if (gzip) source.pipe(cipher);

  const finished = new Promise((resolve, reject) => {
    cipher.on("data", (chunk) => {
      if (!out.write(chunk)) {
        cipher.pause();
        out.once("drain", () => cipher.resume());
      }
    });
    cipher.on("end", () => {
      out.end(cipher.getAuthTag());
    });
    out.on("finish", resolve);
    out.on("error", reject);
    cipher.on("error", reject);
    source.on("error", reject);
  });

  let count = 0;

  return {
    get count() {
      return count;
    },
    async write(record) {
      count += 1;
      if (!source.write(JSON.stringify(record) + "\n")) {
        await new Promise((resolve) => source.once("drain", resolve));
      }
    },
    async close() {
      source.end();
      await finished;
      await fsp.rename(tmp, file);
    },
    async abort() {
      source.destroy();
      out.destroy();
      await fsp.rm(tmp, { force: true });
    },
  };
}

/**
 * Read an encrypted JSONL file one record at a time.
 *
 *   for await (const { line, record } of readLines(file)) { ... }
 *
 * `line` is 1-based, which is what import_line counts and what Shopify's bulk
 * results refer back to. GCM verifies the whole file at the end: a tampered
 * file throws there.
 */
async function* readLines(file, { gzip = /\.gz\.enc$/.test(file) } = {}) {
  const handle = await fsp.open(file, "r");
  let size;
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);

  try {
    size = (await handle.stat()).size;
    if (size < HEADER_BYTES + TAG_BYTES) throw new Error(`${path.basename(file)} is truncated`);
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }

  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`${path.basename(file)} is not a migration data file`);
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    fileKey(),
    header.subarray(MAGIC.length)
  );
  decipher.setAuthTag(tag);

  // The ciphertext only: between the header and the tag. An empty file has
  // no ciphertext, and createReadStream cannot express an empty range.
  const cipherBytes = size - HEADER_BYTES - TAG_BYTES;
  const raw = cipherBytes > 0
    ? fs.createReadStream(file, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 })
    : require("stream").Readable.from([]);

  let stream = raw.pipe(decipher);
  raw.on("error", (err) => decipher.destroy(err));
  if (gzip) {
    const gunzip = zlib.createGunzip();
    decipher.on("error", (err) => gunzip.destroy(err));
    stream = stream.pipe(gunzip);
  }

  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;

  for await (const text of lines) {
    if (!text) continue;
    line += 1;
    yield { line, record: JSON.parse(text) };
  }
}

/** The finished export parts for a data type, in order. */
async function exportParts(storagePath, entity) {
  const dir = path.join(resolveDir(storagePath), "export");
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const pattern = new RegExp(`^${entity}\\.part-(\\d+)\\.jsonl\\.gz\\.enc$`);
  return names
    .filter((name) => pattern.test(name))
    .sort((a, b) => Number(a.match(pattern)[1]) - Number(b.match(pattern)[1]))
    .map((name) => path.join(dir, name));
}

/** Every record exported for a data type, across all its parts. */
async function* readExport(storagePath, entity) {
  for (const file of await exportParts(storagePath, entity)) {
    for await (const { record } of readLines(file)) yield record;
  }
}

/** Throw away export parts and half-written files for a data type. */
async function clearExport(storagePath, entity) {
  const dir = path.join(resolveDir(storagePath), "export");
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(`${entity}.part-`))
      .map((name) => fsp.rm(path.join(dir, name), { force: true }))
  );
}

/** Half-written parts left by a crash. The DB only counted finished ones. */
async function clearTmp(storagePath) {
  for (const sub of ["export", "import"]) {
    const dir = path.join(resolveDir(storagePath), sub);
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith(".tmp"))
        .map((name) => fsp.rm(path.join(dir, name), { force: true }))
    );
  }
}

/* ------------------------------------------------------------------ */
/* errors.csv                                                          */
/* ------------------------------------------------------------------ */

const ERROR_HEADER = "entity,old_id,name,kind,reason";

function csvCell(value) {
  const text = String(value === null || value === undefined ? "" : value)
    .replace(/[\r\n]+/g, " ")
    .trim();
  // A leading = + - @ makes Excel run the cell as a formula.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Note a record that failed or was skipped.
 *
 * `name` must never be personal data: products and pages give their title;
 * customers and orders give "Customer #201" / "Order #1045" only.
 */
async function appendError(storagePath, { entity, sourceId, name, kind = "failed", reason }) {
  const file = path.join(resolveDir(storagePath), "errors.csv");
  let prefix = "";
  try {
    await fsp.access(file);
  } catch {
    prefix = ERROR_HEADER + "\n";
  }
  const row = [entity, sourceId, name, kind, reason].map(csvCell).join(",");
  await fsp.appendFile(file, prefix + row + "\n");
}

/** Split one CSV line, honouring quotes. */
function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/**
 * The error rows, newest last. Later rows for the same record replace earlier
 * ones (a retry inside the same run). Returns [] when there is no file.
 */
async function readErrors(storagePath) {
  let text;
  try {
    text = await fsp.readFile(path.join(resolveDir(storagePath), "errors.csv"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const rows = new Map();
  text.split(/\r?\n/).slice(1).filter(Boolean).forEach((line) => {
    const [entity, sourceId, name, kind, reason] = parseCsvLine(line);
    const label = BY_KEY[entity] ? BY_KEY[entity].label : entity;
    rows.set(`${entity}:${sourceId}`, {
      entity,
      entityLabel: label,
      sourceId,
      name: String(name || "").replace(/^'/, ""),
      kind: kind || "failed",
      reason,
    });
  });
  return [...rows.values()];
}

async function errorsCsv(storagePath) {
  try {
    return await fsp.readFile(path.join(resolveDir(storagePath), "errors.csv"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return ERROR_HEADER + "\n";
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* log.txt                                                             */
/* ------------------------------------------------------------------ */

function stamp(date = new Date()) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

async function log(storagePath, message) {
  try {
    await fsp.appendFile(
      path.join(resolveDir(storagePath), "log.txt"),
      `${stamp()}  ${String(message).replace(/[\r\n]+/g, " ")}\n`
    );
  } catch (err) {
    // A diary that cannot be written must never stop the migration.
    console.warn(`log.txt write failed for ${storagePath}: ${err.message}`);
  }
}

async function readLog(storagePath, { tail = 200 } = {}) {
  try {
    const text = await fsp.readFile(path.join(resolveDir(storagePath), "log.txt"), "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-tail);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* deleting                                                            */
/* ------------------------------------------------------------------ */

const PERSONAL = Object.values(BY_KEY).filter((entity) => entity.personal).map((entity) => entity.key);

/** Customer and order files: the 30-day deletion, and customers/redact. */
async function deletePersonalFiles(storagePath) {
  let dir;
  try {
    dir = resolveDir(storagePath);
  } catch {
    return;
  }
  for (const sub of ["export", "import"]) {
    let names = [];
    try {
      names = await fsp.readdir(path.join(dir, sub));
    } catch {
      continue;
    }
    await Promise.all(
      names
        .filter((name) => PERSONAL.some((entity) => name.startsWith(`${entity}.`)))
        .map((name) => fsp.rm(path.join(dir, sub, name), { force: true }))
    );
  }
}

/** The whole folder: the 90-day deletion, "Delete migration data now", shop/redact. */
async function deleteFolder(storagePath) {
  await fsp.rm(resolveDir(storagePath), { recursive: true, force: true });
}

/** Every folder a shop has, for shop/redact. */
async function deleteShopFolders(shopDomain) {
  const base = path.join(STORAGE_ROOT, "migrations");
  let platforms = [];
  try {
    platforms = await fsp.readdir(base);
  } catch {
    return;
  }
  const shop = safeSegment(shopDomain);
  await Promise.all(
    platforms.map((platform) =>
      fsp.rm(path.join(base, platform, shop), { recursive: true, force: true })
    )
  );
}

/** Fail cleanly before an export instead of crashing half way. */
async function assertFreeDisk() {
  await fsp.mkdir(STORAGE_ROOT, { recursive: true });
  if (typeof fsp.statfs !== "function") return;
  const stats = await fsp.statfs(STORAGE_ROOT);
  const freeMb = (Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024);
  if (freeMb < MIN_FREE_DISK_MB) {
    throw new Error(
      `Not enough free disk space on the server (${Math.round(freeMb)} MB free, ${MIN_FREE_DISK_MB} MB needed)`
    );
  }
}

module.exports = {
  STORAGE_ROOT,
  storagePathFor,
  resolveDir,
  ensureDir,
  exportPartName,
  importFileName,
  openWriter,
  readLines,
  exportParts,
  readExport,
  clearExport,
  clearTmp,
  appendError,
  readErrors,
  errorsCsv,
  parseCsvLine,
  log,
  readLog,
  deletePersonalFiles,
  deleteFolder,
  deleteShopFolders,
  assertFreeDisk,
  resetKeyCacheForTests: () => {
    cachedKey = null;
  },
};
