export type RewindLockHandle = {
  runId: string;
  ownerToken: string;
  readonly expiresAtMs: number;
  renew: () => Promise<boolean>;
  checkStillHeld: () => Promise<boolean>;
  release: () => Promise<boolean>;
};
