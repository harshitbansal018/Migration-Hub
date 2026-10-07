// services/migration/bulk.js
//
// Big shops: instead of sending 50,000 orders one at a time, we upload one
// file to Shopify and Shopify creates everything on its own servers.
//
//   1. Upload   stagedUploadsCreate -> POST the JSONL of variables
//   2. Start    bulkOperationRunMutation
//   3. Wait     Shopify works; we ask "done yet?" every 30 s (one tiny request)
//   4. Results  stream Shopify's result file line by line:
//                 {"data": {...}, "__lineNumber": 0}
//
// The operation id is saved on the step, so a worker that restarts while
// Shopify is still working picks the same operation up instead of starting
// another one.
const readline = require("readline");
const { Readable } = require("stream");

const shopify = require("../shopify");

const POLL_MS = Number(process.env.BULK_POLL_MS || 30000);
/** Shopify accepts up to 20 MB of variables per operation; stay below. */
const MAX_UPLOAD_BYTES = Number(process.env.BULK_MAX_UPLOAD_BYTES || 15 * 1024 * 1024);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gql(shop, query, variables) {
  return shopify.forShop(shop, { query, variables });
}

/** Upload the variables file. Returns the stagedUploadPath. */
async function upload(shop, jsonl) {
  const data = await gql(
    shop,
    `mutation Stage($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [{
        resource: "BULK_MUTATION_VARIABLES",
        filename: "migration_variables.jsonl",
        mimeType: "text/jsonl",
        httpMethod: "POST",
      }],
    }
  );

  const result = data.stagedUploadsCreate;
  if (result.userErrors.length) throw new Error(`Staged upload failed: ${result.userErrors[0].message}`);

  const target = result.stagedTargets[0];
  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "migration_variables.jsonl");

  const response = await fetch(target.url, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Uploading the import file to Shopify failed (${response.status})`);
  }

  const key = target.parameters.find((parameter) => parameter.name === "key");
  if (!key) throw new Error("Shopify's staged upload did not return a key");
  return key.value;
}

/** Start the operation. Waits its turn if another bulk mutation is running. */
async function start(shop, mutation, stagedUploadPath) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const data = await gql(
      shop,
      `mutation Run($mutation: String!, $path: String!) {
        bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
          bulkOperation { id status }
          userErrors { field message }
        }
      }`,
      { mutation, path: stagedUploadPath }
    );

    const result = data.bulkOperationRunMutation;
    if (result.bulkOperation) return result.bulkOperation.id;

    const message = result.userErrors.map((error) => error.message).join("; ");
    if (/already in progress/i.test(message)) {
      await sleep(POLL_MS);
      continue;
    }
    throw new Error(`Shopify refused the bulk import: ${message}`);
  }
  throw new Error("Another bulk operation kept Shopify busy for too long");
}

/**
 * Wait for an operation to finish. `onTick` runs before each wait and may
 * return "stop" (paused or cancelled) to give up waiting -- the operation
 * keeps running at Shopify and is picked up again on resume.
 *
 * Returns { status, url, partialDataUrl, errorCode, objectCount }, or null
 * when stopped.
 */
async function waitFor(shop, operationId, onTick) {
  for (;;) {
    const data = await gql(
      shop,
      `query Op($id: ID!) {
        node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl } }
      }`,
      { id: operationId }
    );
    const operation = data.node;
    if (!operation) throw new Error("Shopify no longer knows this bulk operation");

    if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(operation.status)) return operation;

    if (onTick && (await onTick(operation)) === "stop") return null;
    await sleep(POLL_MS);
  }
}

/**
 * The bulk mutation Shopify started for us at or after `sinceIso`, if any --
 * for a worker that died between starting an operation and saving its id.
 */
async function adoptRecent(shop, sinceIso) {
  const data = await gql(shop, "{ currentBulkOperation(type: MUTATION) { id status createdAt } }");
  const operation = data.currentBulkOperation;
  if (!operation) return null;
  const since = new Date(sinceIso).getTime() - 5000;
  return new Date(operation.createdAt).getTime() >= since ? operation.id : null;
}

/** Shopify's result file, one parsed line at a time. */
async function* results(url) {
  if (!url) return;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Downloading Shopify's results failed (${response.status})`);

  const lines = readline.createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
  for await (const text of lines) {
    if (text) yield JSON.parse(text);
  }
}

module.exports = { upload, start, waitFor, adoptRecent, results, MAX_UPLOAD_BYTES, POLL_MS };
