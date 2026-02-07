import { Electroview } from "electrobun/view";
import type { AppRPCType } from "../../shared/rpc.js";
import type { RpcClient, RpcFactory, RpcHandlers } from "@smithers/ui/rpc";

export const createElectrobunRpc: RpcFactory = (handlers: RpcHandlers): RpcClient => {
  // 5 min timeout: native file dialogs block until the user picks a folder
  const rpc = Electroview.defineRPC<AppRPCType>({ handlers, maxRequestTime: 300_000 });
  new Electroview({ rpc });
  return rpc as unknown as RpcClient;
};
