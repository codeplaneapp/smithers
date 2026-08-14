import type { FilePatch } from "./FilePatch.ts";

export type DiffBundle = {
  seq: number;
  baseRef: string;
  patches: FilePatch[];
  /** True when computed from a live working copy (not an immutable ref pair). */
  live?: boolean;
};
