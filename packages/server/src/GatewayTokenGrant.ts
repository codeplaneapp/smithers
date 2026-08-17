export type GatewayTokenGrant = {
  role: string;
  scopes: string[];
  userId?: string;
  /** Application half of the persisted `(owner, app)` tenant key. */
  appId?: string;
  tokenId?: string;
  issuedAtMs?: number;
  expiresAtMs?: number;
  revokedAtMs?: number;
};
