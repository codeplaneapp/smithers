export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  apiVersion?: "v1";
  payload?: unknown;
  error?: {
    version?: "v1";
    code: string;
    message: string;
    requiredScope?: string;
    refresh?: string;
    details?: unknown;
  };
};
