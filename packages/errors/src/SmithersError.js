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
        // options bag only when it owns at least one known option key
        // (cause/includeDocsUrl/name), so most plain-object causes still
        // round-trip as the cause.
        const isOptionsObject = causeOrOptions &&
            typeof causeOrOptions === "object" &&
            !(causeOrOptions instanceof Error) &&
            (Object.prototype.hasOwnProperty.call(causeOrOptions, "cause") ||
                Object.prototype.hasOwnProperty.call(causeOrOptions, "includeDocsUrl") ||
                Object.prototype.hasOwnProperty.call(causeOrOptions, "name"));
        const options = /** @type {SmithersErrorOptions} */ (isOptionsObject
            ? causeOrOptions
            : { cause: causeOrOptions });
        // Append the docs pointer unless suppressed or the summary already contains it.
        const message = options.includeDocsUrl === false || summary.includes(docsUrl)
            ? summary
            : `${summary} See ${docsUrl}`;
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
