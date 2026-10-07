// models/faqModel.js
//
// `faqs` -- the questions and answers on the Help screen.
//
// These live in the database, not in the code, for one reason: support can
// reword an answer, add a question or hide one without a deploy.
//
// Not scoped to a store. Every merchant sees the same list.
const { query, pool } = require("../config/db");

/**
 * The questions merchants see, in the order they should read.
 *
 * Hidden rows are filtered out here rather than in the view, so no screen can
 * accidentally show a question that was taken down.
 */
async function listActive() {
  return query(
    `SELECT id, question, answer, position
       FROM faqs
      WHERE is_active = 1
      ORDER BY position, id`
  );
}

/** Every row, hidden ones included, for whoever is editing the list. */
async function listAll() {
  return query("SELECT * FROM faqs ORDER BY position, id");
}

async function findById(id) {
  const rows = await query("SELECT * FROM faqs WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
}

/**
 * Add a question. Position defaults to the end of the list, so a new row does
 * not silently jump to the top of a list somebody has already ordered.
 */
async function create({ question, answer, position = null, isActive = true }) {
  if (!String(question || "").trim() || !String(answer || "").trim()) {
    throw new Error("A question needs both a question and an answer.");
  }

  const at =
    position === null || position === undefined
      ? Number(
          (await query("SELECT COALESCE(MAX(position), 0) + 10 AS next FROM faqs"))[0]
            .next
        )
      : Number(position);

  const [result] = await pool.query(
    `INSERT INTO faqs (question, answer, position, is_active)
     VALUES (?, ?, ?, ?)`,
    [String(question).trim().slice(0, 512), String(answer).trim(), at, isActive ? 1 : 0]
  );

  return findById(result.insertId);
}

/**
 * Change one. Only the keys actually passed are written, so a caller sending
 * just a new answer does not blank the question.
 */
async function update(id, changes = {}) {
  const sets = [];
  const params = [];

  if (changes.question !== undefined) {
    sets.push("question = ?");
    params.push(String(changes.question).trim().slice(0, 512));
  }

  if (changes.answer !== undefined) {
    sets.push("answer = ?");
    params.push(String(changes.answer).trim());
  }

  if (changes.position !== undefined) {
    sets.push("position = ?");
    params.push(Number(changes.position) || 0);
  }

  if (changes.isActive !== undefined) {
    sets.push("is_active = ?");
    params.push(changes.isActive ? 1 : 0);
  }

  if (!sets.length) return findById(id);

  params.push(id);

  await pool.query(`UPDATE faqs SET ${sets.join(", ")} WHERE id = ?`, params);

  return findById(id);
}

async function remove(id) {
  const [result] = await pool.query("DELETE FROM faqs WHERE id = ?", [id]);
  return result.affectedRows;
}

module.exports = {
  listActive,
  listAll,
  findById,
  create,
  update,
  remove,
};
