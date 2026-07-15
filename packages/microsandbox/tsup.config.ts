import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.js" },
	dts: { only: true, resolve: false },
	outDir: "src",
	format: ["esm"],
	splitting: false,
	clean: ["index.d.ts"],
	silent: true,
});
