import { defineConfig } from "tsup";

export default defineConfig({
	entry: [
		"src/index.js",
		"src/HERDR_PROTOCOL.js",
		"src/HerdrError.js",
		"src/cockpitLayout.js",
		"src/cockpitPolicy.js",
		"src/createHerdrClient.js",
		"src/createHerdrRunSurface.js",
		"src/digest.js",
		"src/ndjson.js",
		"src/resolveSocketPath.js",
		"src/sessionLifecycle.js",
	],
	dts: { only: true, resolve: false },
	format: ["esm"],
	splitting: false,
	clean: false,
	outDir: "src",
});
