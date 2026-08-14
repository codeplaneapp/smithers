// Builds one Gateway UI bundle in a pristine process and writes it to stdout.
// bundleGatewayUiEntry falls back to this worker when the in-process Bun.build
// fails: globally registered Bun runtime plugins (e.g. the engine's
// workflow-module-resolution virtual modules) leak into in-process builds that
// pass a `plugins` array and break bare-specifier resolution. This process is
// spawned with a cwd that has no bunfig.toml, so nothing is preloaded and the
// runtime-module registry stays empty.
import { buildGatewayUiBundle } from "./bundle.js";

try {
  const { config, cwd } = JSON.parse(await Bun.stdin.text());
  if (cwd) {
    process.chdir(cwd);
  }
  let inputFiles = [];
  const body = await buildGatewayUiBundle(config, (inputs) => {
    inputFiles = inputs;
  });
  process.stdout.write(`${JSON.stringify(inputFiles)}\n`);
  process.stdout.write(body);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
