export type GatewayTokenGrant = {
  role: string;
  scopes: string[];
  userId?: string;
  tokenId?: string;
  issuedAtMs?: number;
  expiresAtMs?: number;
  revokedAtMs?: number;
};
