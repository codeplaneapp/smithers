import type { RpcClient, RpcHandlers, RpcMessageMap, RpcRequestFns } from "./types.js";

const MESSAGE_NAMES: Array<keyof RpcMessageMap> = [
  "agentEvent",
  "chatMessage",
  "workflowEvent",
  "workflowFrame",
  "workspaceState",
  "toast",
];

function createRequestProxy(): RpcRequestFns {
  return new Proxy({} as RpcRequestFns, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return async (params: unknown) => {
        const res = await fetch("/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: prop, params: params ?? {} }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload?.ok) {
          const message = payload?.error?.message ?? `RPC ${prop} failed`;
          throw new Error(message);
        }
        return payload.result as any;
      };
    },
  });
}

export function createWebRpcClient(handlers: RpcHandlers): RpcClient {
  const request = createRequestProxy();
  const eventSource = new EventSource("/events");

  for (const name of MESSAGE_NAMES) {
    eventSource.addEventListener(name, (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data ?? "null");
        const handler = handlers.messages?.[name];
        if (handler) {
          handler(data as any);
        }
      } catch (err) {
        console.warn("[web rpc] failed to parse event", name, err);
      }
    });
  }

  eventSource.addEventListener("error", () => {
    // Keep quiet; the UI will retry via browser EventSource automatically.
  });

  return { request };
}
