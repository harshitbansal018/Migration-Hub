// services/mailer.js
//
// The "your migration is finished" email. Sent only when SMTP is configured
// (SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM) and the store has an email;
// otherwise it quietly does nothing -- the results screen is the record.
//
// Counts and reasons only. Never a customer's name or email.
const { escapeHtml } = require("../utils/html");

let transport = null;

function getTransport() {
  if (transport !== null) return transport;
  if (!process.env.SMTP_HOST) {
    transport = false;
    return transport;
  }
  // Required lazily: an install without SMTP does not need the package.
  const nodemailer = require("nodemailer");
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST.trim(),
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

function appUrl(store) {
  return `https://${store.shop_domain}/admin/apps/${encodeURIComponent(process.env.SHOPIFY_API_KEY || "")}`;
}

async function migrationFinished(store, migration) {
  const mail = getTransport();
  if (!mail || !store.email || migration.type === "demo") return false;

  const failed = Number(migration.failed) || 0;
  const moved = Number(migration.succeeded) || 0;
  const subject = failed
    ? `Migration #${migration.id} finished — ${moved.toLocaleString("en-US")} migrated, ${failed} need attention`
    : `Migration #${migration.id} finished — ${moved.toLocaleString("en-US")} records migrated`;

  const link = `${appUrl(store)}/migrations/${migration.id}`;
  const text = [
    `Your migration from ${migration.base_url} to ${store.shop_domain} has finished.`,
    "",
    `Migrated: ${moved}`,
    `Failed: ${failed}`,
    `Skipped (already existed): ${Number(migration.skipped) || 0}`,
    "",
    failed ? "Open the results to see what needs attention and retry it:" : "See the full results:",
    link,
    "",
    "Migration files are kept for 30 days (customers and orders) and 90 days (everything else), then deleted automatically.",
  ].join("\n");

  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:520px">
    <h2 style="margin:0 0 12px;font-size:20px">Migration #${migration.id} finished</h2>
    <p>Your migration from <strong>${escapeHtml(migration.base_url)}</strong> to <strong>${escapeHtml(store.shop_domain)}</strong> has finished.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:4px 24px 4px 0;color:#616161">Migrated</td><td><strong>${moved.toLocaleString("en-US")}</strong></td></tr>
      <tr><td style="padding:4px 24px 4px 0;color:#616161">Failed</td><td><strong style="color:${failed ? "#b3261e" : "inherit"}">${failed}</strong></td></tr>
      <tr><td style="padding:4px 24px 4px 0;color:#616161">Skipped</td><td>${Number(migration.skipped) || 0}</td></tr>
    </table>
    <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0b5368;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">View results</a></p>
    <p style="color:#616161;font-size:13px">Migration files are kept for 30 days (customers and orders) and 90 days (everything else), then deleted automatically.</p>
  </div>`;

  await mail.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: store.email,
    subject,
    text,
    html,
  });
  return true;
}

module.exports = { migrationFinished };
