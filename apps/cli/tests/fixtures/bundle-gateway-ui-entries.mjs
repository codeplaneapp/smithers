import { bundleGatewayUiEntry } from "../../../../packages/server/src/gatewayUi/bundle.js";

const cache = new Map();
const failures = [];

for (const entry of process.argv.slice(2)) {
  try {
    await bundleGatewayUiEntry({ entry }, cache);
  } catch (error) {
    failures.push(
      `${entry}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

process.stdout.write(JSON.stringify({ failures }));
