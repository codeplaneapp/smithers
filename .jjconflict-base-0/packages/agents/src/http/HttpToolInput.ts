import type { HttpToolAuth } from "./HttpToolAuth.ts";

export type HttpToolInput = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  auth?: HttpToolAuth;
  timeoutMs?: number;
};
