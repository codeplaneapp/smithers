import { createCommandSandboxProvider, createSandboxProviderContractSuite } from "../src/provider-kit/index.js";

const RESULT_FILE = ".smithers/sandbox-result.json";
const REQUEST_FILE = ".smithers/sandbox-request.json";

/**
 * Reference in-memory provider built ON TOP of createCommandSandboxProvider.
 * The fake session's exec parses the shipped request file, invokes the contract
 * handler, and writes the handler's JSON to the result file. This proves the
 * shared contract suite runs against a real kit-backed provider.
 *
 * @param {(args: { command: string; request: Record<string, unknown>; files: Map<string, string>; env: Record<string, string> }) => import("../src/provider-kit/SandboxSession.ts").SandboxSession | any} handler
 * @param {Record<string, unknown>} [providerOptions]
 */
function createReferenceProvider(handler, providerOptions = {}) {
	const { onDestroy, ...rest } = providerOptions;
	return createCommandSandboxProvider({
		id: "reference-command-sandbox",
		...rest,
		createSession: () => {
			const files = new Map();
			return {
				remoteId: "reference-remote",
				async writeFile(path, content) {
					files.set(path, content);
				},
				async readFile(path) {
					return files.get(path) ?? "";
				},
				async exec(command, opts) {
					const requestEntry = [...files.entries()].find(([path]) => path.endsWith(REQUEST_FILE));
					const request = JSON.parse(requestEntry?.[1] ?? "{}");
					const result = await handler({ command, request, files, env: opts.env });
					const resultPath = [...files.keys()].find((path) => path.endsWith(RESULT_FILE)) ?? `/workspace/${RESULT_FILE}`;
					files.set(resultPath, JSON.stringify(result));
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				async destroy() {
					if (typeof onDestroy === "function") {
						onDestroy();
					}
				},
			};
		},
	});
}

createSandboxProviderContractSuite({
	name: "reference command sandbox provider",
	expectedProviderId: "reference-command-sandbox",
	createProvider: createReferenceProvider,
});
