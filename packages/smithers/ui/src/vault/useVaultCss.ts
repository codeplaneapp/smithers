import { useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { VAULT_CSS_ID, vaultCss } from "./vaultCss";

/** Inject the package sheet plus the vault lane fragment, idempotently. */
export function useVaultCss(): void {
  useInjectUiCss();
  useInjectLaneCss(VAULT_CSS_ID, vaultCss);
}
