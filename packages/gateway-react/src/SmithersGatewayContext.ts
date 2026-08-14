import { createContext } from "react";
import type { SmithersGatewayClient } from "@smthrs/gateway-client";

export const SmithersGatewayContext = createContext<SmithersGatewayClient | null>(null);
