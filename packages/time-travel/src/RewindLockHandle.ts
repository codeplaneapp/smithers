export type RewindLockHandle = {
  runId: string;
  ownerToken: string;
  readonly expiresAtMs: number;
  renew: () => Promise<boolean>;
  release: () => Promise<boolean>;
};
