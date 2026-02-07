import { BrowserWindow, BrowserView, Utils } from "electrobun/bun";
import type { AppRPCType } from "../shared/rpc.js";
import { createAppRuntime } from "@smithers/core";

process.on("uncaughtException", (err) => {
  console.error("[main] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled rejection:", reason);
});

const runtime = createAppRuntime({
  dbPath: process.env.SMITHERS_DB_PATH,
  workspaceRoot: process.env.SMITHERS_WORKSPACE,
});

const rpc = BrowserView.defineRPC<AppRPCType>({
  handlers: {
    ...runtime.handlers,
    requests: {
      ...runtime.handlers.requests,
      browseDirectory: async ({ startingFolder }) => {
        const paths = await Utils.openFileDialog({
          startingFolder: startingFolder ?? "~/",
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });
        // openFileDialog returns [""] when cancelled, filter that out
        const selected = paths.find((p) => p.length > 0);
        return { path: selected ?? null };
      },
    },
  },
});

runtime.setSend({
  agentEvent: (payload) => rpc.send.agentEvent(payload),
  chatMessage: (payload) => rpc.send.chatMessage(payload),
  workflowEvent: (payload) => rpc.send.workflowEvent(payload),
  workflowFrame: (payload) => rpc.send.workflowFrame(payload),
  workspaceState: (payload) => rpc.send.workspaceState(payload),
  toast: (payload) => rpc.send.toast(payload),
});

const win = new BrowserWindow({
  title: "Smithers",
  frame: { width: 1400, height: 900, x: 100, y: 100 },
  url: "views://main/index.html",
  rpc,
});

void runtime.emitWorkspaceState();

// Keep Bun event loop alive for native window lifecycle.
const keepAlive = setInterval(() => {}, 60_000);

win.on("closed", () => {
  clearInterval(keepAlive);
  runtime.shutdown();
});
