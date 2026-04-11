export type RunAuthContext = {
  readonly userId?: string;
  readonly orgId?: string;
  readonly scopes?: readonly string[];
  readonly claims?: Record<string, unknown>;
  readonly [key: string]: unknown;
};
