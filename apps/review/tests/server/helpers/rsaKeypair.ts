/**
 * Generate an RSA keypair and the JWK shape we need to:
 *   - serve a JWKS at a fixture URL (publicJwk + "kid")
 *   - sign test JWTs with the private key
 *
 * Tests rotate keypairs between cases so the JWKS cache miss path is real.
 */
export interface RsaTestKeypair {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

export async function rsaKeypair(kid: string): Promise<RsaTestKeypair> {
  const keypair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  return {
    kid,
    privateKey: keypair.privateKey,
    publicJwk: {
      kty: publicJwk.kty,
      n: publicJwk.n,
      e: publicJwk.e,
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}
