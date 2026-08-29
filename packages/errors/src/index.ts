/**
 * Error types shared by the Smithers integration adapters.
 *
 * @since 1.0.0
 */
export {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  getSmithersErrorDocsUrl,
  isKnownSmithersErrorCode,
  type KnownSmithersErrorCode,
  knownSmithersErrorCodes,
  type SmithersErrorCode,
  type SmithersErrorDefinition,
  smithersErrorDefinitions
} from "./ErrorCode.ts"
export { isSmithersError, SmithersError, type SmithersErrorOptions } from "./SmithersError.ts"
