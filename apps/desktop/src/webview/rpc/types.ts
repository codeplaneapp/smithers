import type { AppRPCType } from "../../shared/rpc.js";

type RpcRequestMap = AppRPCType["bun"]["requests"];
export type RpcMessageMap = AppRPCType["bun"]["messages"];

export type RpcHandlers = {
  requests: {};
  messages: { [K in keyof RpcMessageMap]?: (payload: RpcMessageMap[K]) => void };
};

export type RpcRequestFns = {
  [K in keyof RpcRequestMap]: (params: RpcRequestMap[K]["params"]) => Promise<RpcRequestMap[K]["response"]>;
};

export type RpcClient = {
  request: RpcRequestFns;
};

export type RpcFactory = (handlers: RpcHandlers) => RpcClient;
