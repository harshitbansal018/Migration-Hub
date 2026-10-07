// config/db.js
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: "Z",
});

/**
 * Run a query and return rows only.
 */
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * Run `fn` inside a transaction on a dedicated connection.
 * Rolls back on any throw, always releases the connection.
 */
async function withTransaction(fn) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Create DB_NAME if it does not exist yet, so a fresh machine needs nothing
 * but a running MySQL server. Uses a one-off connection with no database
 * selected: the pool cannot connect until the database is there.
 */
async function ensureDatabase() {
  const name = String(process.env.DB_NAME || "");

  // Interpolated into DDL (identifiers cannot be bound as parameters), so
  // only a plain identifier is accepted.
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`DB_NAME "${name}" must contain only letters, digits and _`);
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\`
         DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await connection.end();
  }
}

async function assertConnection() {
  const connection = await pool.getConnection();
  connection.release();
  console.log("MySQL pool ready");
}

module.exports = { pool, query, withTransaction, ensureDatabase, assertConnection };
