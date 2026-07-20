import { bundleGatewayUiEntry } from "../../../../packages/server/src/gatewayUi/bundle.js";

const entries = JSON.parse(process.argv[2] ?? "[]");
if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
  throw new TypeError("Expected a JSON array of Gateway UI entry paths");
}

const cache = new Map();
const bundles = [];
for (const entry of entries) {
  const body = await bundleGatewayUiEntry({ entry }, cache);
  bundles.push({ entry, bytes: Buffer.byteLength(body) });
}

process.stdout.write(JSON.stringify(bundles));
