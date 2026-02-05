import { Electroview } from "electrobun/view";
import type { AppRPCType } from "../../shared/rpc.js";
import type { RpcClient, RpcFactory, RpcHandlers } from "./types.js";

export const createElectrobunRpc: RpcFactory = (handlers: RpcHandlers): RpcClient => {
  const rpc = Electroview.defineRPC<AppRPCType>({ handlers });
  new Electroview({ rpc });
  return rpc as unknown as RpcClient;
};
