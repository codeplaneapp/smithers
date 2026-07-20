import type { Server } from "node:http";
import type { SmithersElectricProxy } from "./SmithersElectricProxyOptions.ts";

export type ServeSmithersElectricProxyOptions = {
  proxy: SmithersElectricProxy;
  port?: number;
  host?: string;
};

export type SmithersElectricProxyServer = {
  server: Server;
  port: number;
  close(): Promise<void>;
};
