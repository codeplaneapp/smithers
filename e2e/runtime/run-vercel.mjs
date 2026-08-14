import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { assertRuntimeConformance } from "@smthrs/testing/runtimeConformance";
import { terminateChild } from "./terminateChild.mjs";

// Drive @vercel/node's own local Node.js function bridge directly
// (the same module `vercel dev` forks internally to serve a Node
// function) instead of the `vercel` CLI. The CLI's `dev`/`link` flow
// reaches out to the Vercel API and, on any machine with a cached
// `vercel login` token, silently authenticates as that real account
// and creates a real project -- there is no CLI flag that makes
// project-linking itself work fully offline. Forking the bridge
// module skips that layer entirely: no network calls, no account,
// no `.vercel` directory, just the real request/response runtime.
const require = createRequire(import.meta.url);
const devServerPath = require.resolve("@vercel/node/dist/dev-server.mjs");

const child = fork(devServerPath, [], {
  cwd: process.cwd(),
  env: { ...process.env, VERCEL_DEV_ENTRYPOINT: "runtime/vercel-api.js" },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let stderr = "";
child.stderr?.on("data", (chunk) => { stderr += chunk; });

try {
  const address = await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const onMessage = (message) => {
      cleanup();
      resolve(message);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Vercel dev-server exited early (code ${code}): ${stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Vercel local runtime did not become ready within 15s: ${stderr}`));
    }, 15_000);
    child.once("message", onMessage);
    child.once("exit", onExit);
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/conformance`);
  if (!response.ok) throw new Error(`Vercel local runtime request failed (${response.status}): ${await response.text()}`);
  assertRuntimeConformance(await response.json(), "Vercel");
  console.log("Vercel runtime conformance passed");
} finally {
  await terminateChild(child);
}
