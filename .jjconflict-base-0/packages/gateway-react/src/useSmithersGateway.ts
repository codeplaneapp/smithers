import { useContext } from "react";
import { SmithersGatewayContext } from "./SmithersGatewayContext.ts";

export function useSmithersGateway() {
  const client = useContext(SmithersGatewayContext);
  if (!client) {
    throw new Error("useSmithersGateway() must be used inside <SmithersGatewayProvider>.");
  }
  return client;
}
