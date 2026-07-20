export type ApiMutationResult<T> = {
  data: T;
  seq?: number;
  txid?: string;
};
