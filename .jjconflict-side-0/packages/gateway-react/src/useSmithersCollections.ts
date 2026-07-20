import { useContext, useEffect } from "react";
import { SmithersCollectionsContext } from "./SmithersCollectionsContext.ts";

export function useSmithersCollections() {
  const value = useContext(SmithersCollectionsContext);
  if (!value) {
    throw new Error("useSmithersCollections: missing <SmithersCollectionsProvider>.");
  }
  useEffect(() => {
    value.collections.connect();
  }, [value.collections]);
  return value;
}
