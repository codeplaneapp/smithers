import type { RalphSnapshot } from "./RalphSnapshot";

export type RalphChange = {
  ralphId: string;
  from: RalphSnapshot;
  to: RalphSnapshot;
};
