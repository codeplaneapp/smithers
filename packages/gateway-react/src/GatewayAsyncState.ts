export type GatewayAsyncState<T> = {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => Promise<void>;
};

type GatewayLiveQueryState = {
  isError: boolean;
  isReady: boolean;
};

type GatewayCollectionState = {
  id?: string;
  utils?: {
    lastError?: unknown;
  };
};

export function normalizeError(error: unknown): Error | undefined {
  if (error === undefined || error === null) return undefined;
  return error instanceof Error ? error : new Error(String(error));
}

/** Maps a collection-backed live query to the public async-state contract. */
export function gatewayCollectionAsyncState<T>(options: {
  collection: GatewayCollectionState;
  data: T | undefined;
  hasData: boolean;
  live: GatewayLiveQueryState;
  refetch: () => Promise<void>;
}): GatewayAsyncState<T> {
  const sourceError = normalizeError(options.collection.utils?.lastError);
  const error =
    sourceError ??
    (options.live.isError
      ? new Error(`Gateway live query failed${options.collection.id ? ` for ${options.collection.id}` : ""}.`)
      : undefined);

  return {
    data: options.data,
    error,
    loading: !options.live.isReady && !error && !options.hasData,
    refetch: options.refetch,
  };
}
