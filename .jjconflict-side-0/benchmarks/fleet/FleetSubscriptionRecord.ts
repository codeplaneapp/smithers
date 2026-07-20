/**
 * A logged-in Claude subscription in the fleet manifest
 * (`$SMITHERS_HOME/.smithers/fleet/subscriptions.json`). Each maps to one
 * rollout container. `configDir` holds this account's `.credentials.json`
 * (with a refresh token, so the CLI self-refreshes); mount it into the
 * container, or mint a portable `CLAUDE_CODE_OAUTH_TOKEN` from it for env
 * injection (`fleet tokens`).
 */
export type FleetSubscriptionRecord = {
  id: string;
  label: string;
  configDir: string;
};
