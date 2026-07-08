import type { Account } from "./Account";

export type AccountsFile = {
  version: 1;
  accounts: Account[];
  /**
   * Raw, unvalidated entries whose `provider` was not recognized at parse
   * time (e.g. a legacy subscription provider that has since been removed).
   * Kept verbatim so a rewrite of unrelated accounts never deletes them —
   * writeAccounts re-appends them to the on-disk `accounts` array.
   */
  unknownAccounts?: unknown[];
};
