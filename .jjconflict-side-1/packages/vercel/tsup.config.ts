import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.js"],
	dts: true,
	format: ["esm"],
	splitting: false,
	clean: true,
});
