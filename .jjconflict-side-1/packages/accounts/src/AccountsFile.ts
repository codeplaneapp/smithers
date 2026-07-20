import type { Account } from "./Account";
import type { UnknownAccount } from "./UnknownAccount";

export type AccountsFile = {
  version: 1;
  accounts: Account[];
  /**
   * Raw entries whose provider this build does not recognize. Present only when
   * the on-disk file carries such rows. Never serialized under this key —
   * `writeAccounts` merges them back into `accounts` so an unrelated mutation
   * cannot erase them.
   */
  unknownAccounts?: UnknownAccount[];
};
