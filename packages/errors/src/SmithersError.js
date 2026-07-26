import { getSmithersErrorDocsUrl } from "./getSmithersErrorDocsUrl.js";
/** @typedef {import("./SmithersErrorCode.ts").SmithersErrorCode} SmithersErrorCode */
/** @typedef {import("./SmithersErrorOptions.ts").SmithersErrorOptions} SmithersErrorOptions */

export class SmithersError extends Error {
  /** @type {SmithersErrorCode} */
  code;
  /** @type {string} */
  summary;
  /** @type {string} */
  docsUrl;
  /** @type {Record<string, unknown> | undefined} */
  details;
  /** @type {unknown} */
  cause;
  /** @type {string} */
  name;
  /**
   * @param {SmithersErrorCode} code
   * @param {string} summary
   * @param {Record<string, unknown>} [details]
   * @param {unknown | SmithersErrorOptions} [causeOrOptions]
   */
  constructor(code, summary, details, causeOrOptions) {
    const docsUrl = getSmithersErrorDocsUrl(code);
    // The 4th arg historically took a bare `cause`. An object counts as an
    // options bag only when all of its own keys are known options. Any extra
    // data means the whole object is a legacy cause and must round-trip.
    const ownKeys = causeOrOptions && typeof causeOrOptions === "object" ? Reflect.ownKeys(causeOrOptions) : [];
    const isOptionsObject =
      ownKeys.length > 0 &&
      !(causeOrOptions instanceof Error) &&
      ownKeys.every((key) => key === "cause" || key === "includeDocsUrl" || key === "name");
    const options = /** @type {SmithersErrorOptions} */ (isOptionsObject ? causeOrOptions : { cause: causeOrOptions });
    // Append the docs pointer unless suppressed or the summary already contains it.
    const message =
      options.includeDocsUrl === false || summary.includes(docsUrl) ? summary : `${summary} See ${docsUrl}`;
    super(message, { cause: options.cause });
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = options.name ?? "SmithersError";
    this.code = code;
    this.summary = summary;
    this.docsUrl = docsUrl;
    this.details = details;
    this.cause = options.cause;
  }
}
