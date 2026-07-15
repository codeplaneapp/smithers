import { defineConfig } from "tsup";

const declarationEntry = (name: string, source: string) => ({
  entry: { [name]: source },
  dts: { only: true as const, resolve: false },
  outDir: "src",
  format: ["esm" as const],
  silent: true,
});

export default defineConfig([
  declarationEntry("index", "src/index.ts"),
  declarationEntry("gateway-rpc", "src/gateway-rpc.js"),
]);
