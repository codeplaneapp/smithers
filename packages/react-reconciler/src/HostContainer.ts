import type { HostNode } from "@smthrs/graph/types";

export type HostContainer = {
  root: HostNode | null;
  roots?: HostNode[];
};
