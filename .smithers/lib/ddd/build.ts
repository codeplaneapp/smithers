// docs-driven-development build gate. Run as: bun .smithers/lib/ddd/build.ts
// (from the repo root; also works from .smithers/ via root discovery).
// Pipeline: validate features.json -> regenerate derived feature docs ->
// regenerate the UI content modules. Exits nonzero on any failure.
import { dddRoot } from "./dddRoot.ts";
import { generateSpecDocs } from "./generateSpecDocs.ts";
import { generateUiModules } from "./generateUiModules.ts";
import { validateFeatures } from "./validateFeatures.ts";

try {
  const root = dddRoot();
  const features = validateFeatures(root);
  console.log(`ddd build: validated ${features.length} features.`);
  const docs = generateSpecDocs(root);
  console.log(`ddd build: generated ${docs} derived feature docs.`);
  const { docs: docEntries, tickets } = generateUiModules(root);
  console.log(`ddd build: generated UI modules (${docEntries} docs entries, ${tickets} backlog tickets).`);
} catch (error) {
  console.error(`ddd build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
