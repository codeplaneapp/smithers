import { createContext } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { SmithersCollections, SmithersDataClient } from "@smthrs/gateway-client";

export type SmithersCollectionsContextValue = {
  client: SmithersDataClient;
  collections: SmithersCollections;
  queryClient: QueryClient;
};

export const SmithersCollectionsContext = createContext<SmithersCollectionsContextValue | null>(null);
