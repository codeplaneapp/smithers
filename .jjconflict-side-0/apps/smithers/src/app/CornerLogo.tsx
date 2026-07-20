import { SmithersMark } from "./SmithersMark";
import "./cornerLogo.css";

/**
 * The persistent Smithers mark in the top-right corner — the app's logo. The
 * cloud app hides it through the first-run onboarding splash; the local UI has
 * no onboarding, so it is simply always there.
 */
export function CornerLogo() {
  return (
    <div className="corner-logo is-shown" role="img" aria-label="Smithers">
      <SmithersMark part="corner-logo" aria-hidden="true" />
    </div>
  );
}
