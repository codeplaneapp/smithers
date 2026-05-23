import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * @param {Record<string, unknown>} config
 * @param {Map<string, string>} cache
 */
export async function bundleGatewayUiEntry(config, cache) {
    const cached = cache.get(String(config.entry));
    if (cached) {
        return cached;
    }
    if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
        throw new SmithersError("INVALID_INPUT", "Gateway UI bundling requires Bun.build.");
    }
    const result = await Bun.build({
        entrypoints: [String(config.entry)],
        root: process.cwd(),
        target: "browser",
        format: "esm",
        sourcemap: "inline",
        minify: false,
        jsx: {
            runtime: "automatic",
            importSource: "react",
        },
    });
    if (!result.success) {
        const message = result.logs?.map((entry) => entry.message).filter(Boolean).join("\n")
            || `Failed to build Gateway UI entry ${config.entry}`;
        throw new SmithersError("INVALID_INPUT", message);
    }
    const output = result.outputs.find((entry) => entry.path.endsWith(".js")) ?? result.outputs[0];
    const body = await output.text();
    cache.set(String(config.entry), body);
    return body;
}
