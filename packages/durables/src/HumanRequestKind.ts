import type { HUMAN_REQUEST_KINDS } from "./HUMAN_REQUEST_KINDS.ts";

export type HumanRequestKind = (typeof HUMAN_REQUEST_KINDS)[number];
