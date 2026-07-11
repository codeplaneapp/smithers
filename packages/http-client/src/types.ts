export type HttpClientPolicyErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "INVALID_OPTION"
  | "INVALID_REDIRECT"
  | "INSECURE_REDIRECT"
  | "TOO_MANY_REDIRECTS"
  | "UNREPLAYABLE_BODY"
  | "CROSS_ORIGIN_BODY_BLOCKED"
  | "REQUEST_TOO_LARGE"
  | "RESPONSE_TOO_LARGE";

export type HttpClientPolicyErrorDetails = Readonly<Record<string, unknown>>;

export type HttpUrlValidationContext = {
  readonly initial: boolean;
  readonly from?: URL;
};

export type FetchWithPolicyOptions = {
  /** Alternate Fetch implementation, primarily for platform adapters/tests. */
  fetch?: typeof globalThis.fetch;
  /**
   * Origins, in addition to the initial request origin, authorized to receive
   * sensitive headers/query parameters and preserved request bodies.
   */
  allowedOrigins?: readonly (string | URL)[];
  /** Additional case-insensitive header names stripped on unauthorized hops. */
  sensitiveHeaders?: readonly string[];
  /** Additional case-insensitive query parameter names stripped on unauthorized hops. */
  sensitiveQueryParams?: readonly string[];
  /** Maximum followed redirect hops. Defaults to 5. */
  maxRedirects?: number;
  /**
   * Optional destination policy invoked before every fetch, including every
   * redirect hop. It may perform async DNS/private-network validation.
   */
  validateUrl?: (
    url: URL,
    context: HttpUrlValidationContext,
  ) => void | Promise<void>;
};

export type AbortSignalComposition = {
  readonly signal: AbortSignal | undefined;
  cleanup(): void;
};

export type ResponseReadOptions = {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
};

export type AbortableDelayOptions = {
  readonly maxMs?: number;
};
