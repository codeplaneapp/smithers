import { createContext } from "react";
import type { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";

export const SmithersGatewayContext = createContext<SmithersGatewayClient | null>(null);
