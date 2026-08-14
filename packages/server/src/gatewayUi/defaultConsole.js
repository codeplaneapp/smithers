import { loadDefaultOperatorUiClientJs } from "./defaultOperatorUi.js";

/**
 * @returns {Promise<string>}
 */
export function renderDefaultConsoleClient() {
  return loadDefaultOperatorUiClientJs();
}
