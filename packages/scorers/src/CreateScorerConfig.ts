import type { ScorerFn } from "./types";

export type CreateScorerConfig = {
  id: string;
  name: string;
  description: string;
  score: ScorerFn;
};
