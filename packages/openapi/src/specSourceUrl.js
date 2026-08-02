// ---------------------------------------------------------------------------
// specSourceUrl — the URL a spec was loaded from, carried on the spec object
// so a relative `servers[].url` (e.g. the Swagger Petstore's "/api/v3") can be
// resolved against it. Keyed by a registered symbol so it never collides with
// a real OpenAPI field and stays out of spec enumeration.
// ---------------------------------------------------------------------------

/** Symbol key under which the spec's document/base URL is stored. */
export const SPEC_SOURCE_URL = Symbol.for("smthrs/openapi/specSourceUrl");
