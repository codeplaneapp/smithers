// docs-driven-development build gate. Run as: bun .smithers/lib/ddd/build.ts
// (from the repo root; also works from .smithers/ via root discovery).
// Pipeline: validate features.json -> regenerate derived feature docs ->
// regenerate the UI content modules. Exits nonzero on any failure.
import { dddRoot } from "./dddRoot.ts";
import { generateSpecDocs } from "./generateSpecDocs.ts";
import { generateUiModules } from "./generateUiModules.ts";
import { validateFeatures } from "./validateFeatures.ts";

function log(message: string) {
  process.stdout.write(`${message}\n`);
}

try {
  const root = dddRoot();
  const features = validateFeatures(root, { allowMissing: true });
  log(
    features.length === 0
      ? "ddd build: no features.json yet, using empty starter spec."
      : `ddd build: validated ${features.length} features.`,
  );
  const docs = generateSpecDocs(root);
  log(`ddd build: generated ${docs} derived feature docs.`);
  const { docs: docEntries, tickets } = generateUiModules(root);
  log(`ddd build: generated UI modules (${docEntries} docs entries, ${tickets} backlog tickets).`);
} catch (error) {
  console.error(`ddd build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
