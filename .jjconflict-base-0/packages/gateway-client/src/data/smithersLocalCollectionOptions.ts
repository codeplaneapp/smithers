import { queryCollectionOptions, type QueryCollectionConfig } from "@tanstack/query-db-collection";
import type { QueryFunctionContext, QueryKey } from "@tanstack/react-query";

type SmithersQueryFn<T extends object, TQueryKey extends QueryKey> = (
  context: QueryFunctionContext<TQueryKey>,
) => Promise<T[]> | T[];

export function smithersLocalCollectionOptions<
  T extends object,
  TQueryKey extends QueryKey,
  TKey extends string | number = string | number,
>(
  config: Omit<
    QueryCollectionConfig<T, SmithersQueryFn<T, TQueryKey>, unknown, TQueryKey, TKey>,
    "staleTime" | "gcTime" | "retry" | "schema"
  > & {
    schema?: never;
    staleTime?: number;
    gcTime?: number;
    retry?: QueryCollectionConfig<T, SmithersQueryFn<T, TQueryKey>, unknown, TQueryKey, TKey>["retry"];
  },
) {
  return queryCollectionOptions<T, unknown, TQueryKey, TKey>({
    staleTime: 0,
    gcTime: 5 * 60_000,
    retry: false,
    ...config,
  });
}
