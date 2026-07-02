// Mini App initData verification. The valid inputs are signed with an
// INDEPENDENT oracle (node:crypto for HMAC, Web Crypto for Ed25519) so the test
// never trusts the code under test to build its own fixtures. No mocks.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  parseTelegramInitData,
  verifyTelegramWebAppInitData,
  verifyTelegramWebAppInitDataSignature,
} from "../src/telegram/initData.js";

const BOT_TOKEN = "424242:TEST-fixture-bot-token";
const encoder = new TextEncoder();

/** Data-check-string exactly as Telegram builds it (exclude `hash`, sort, \n-join). */
function dataCheckString(fields, exclude) {
  return Object.keys(fields)
    .filter((key) => !exclude.includes(key))
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
}

/** Build a valid HMAC-signed initData string from decoded fields. */
function signHmacInitData(fields, botToken) {
  const dcs = dataCheckString(fields, ["hash"]);
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  params.set("hash", hash);
  return params.toString();
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1000;
const baseFields = () => ({
  auth_date: String(nowSeconds),
  query_id: "AAExampleQueryId",
  user: JSON.stringify({ id: 7, first_name: "Will", username: "will" }),
});

describe("verifyTelegramWebAppInitData (HMAC)", () => {
  test("accepts a correctly signed initData and returns parsed fields", async () => {
    const initData = signHmacInitData(baseFields(), BOT_TOKEN);
    const parsed = await verifyTelegramWebAppInitData(initData, BOT_TOKEN, { nowMs });
    expect(parsed.user?.id).toBe(7);
    expect(parsed.user?.username).toBe("will");
    expect(parsed.queryId).toBe("AAExampleQueryId");
    expect(parsed.authDate).toBe(nowSeconds);
    expect(parsed.hash).toHaveLength(64);
  });

  test("rejects a tampered field (hash no longer matches)", async () => {
    const fields = baseFields();
    const initData = signHmacInitData(fields, BOT_TOKEN);
    // Swap the user id after signing → data-check-string changes, hash stale.
    const tampered = initData.replace("%22id%22%3A7", "%22id%22%3A9");
    expect(tampered).not.toBe(initData);
    await expect(verifyTelegramWebAppInitData(tampered, BOT_TOKEN, { nowMs })).rejects.toThrow(/signature does not match/);
  });

  test("rejects when signed with a different bot token", async () => {
    const initData = signHmacInitData(baseFields(), "999999:some-other-token");
    await expect(verifyTelegramWebAppInitData(initData, BOT_TOKEN, { nowMs })).rejects.toThrow(/does not match/);
  });

  test("rejects expired initData and never leaks the token", async () => {
    const stale = { ...baseFields(), auth_date: String(nowSeconds - 7200) };
    const initData = signHmacInitData(stale, BOT_TOKEN);
    const error = await verifyTelegramWebAppInitData(initData, BOT_TOKEN, { maxAgeSeconds: 3600, nowMs }).catch((e) => e);
    expect(String(error?.message)).toMatch(/expired/);
    expect(JSON.stringify({ m: error?.message, d: error?.details })).not.toContain(BOT_TOKEN);
  });

  test("maxAgeSeconds: 0 disables the freshness check", async () => {
    const stale = { ...baseFields(), auth_date: String(nowSeconds - 999999) };
    const initData = signHmacInitData(stale, BOT_TOKEN);
    const parsed = await verifyTelegramWebAppInitData(initData, BOT_TOKEN, { maxAgeSeconds: 0, nowMs });
    expect(parsed.user?.id).toBe(7);
  });

  test("rejects initData with no hash field", async () => {
    await expect(verifyTelegramWebAppInitData("user=%7B%7D&auth_date=1", BOT_TOKEN, { nowMs })).rejects.toThrow(/missing the hash/);
  });

  test("keeps values containing encoded delimiters intact (URLSearchParams parse)", async () => {
    // A first_name with an ampersand → %26 inside the user JSON. A decode-first
    // parser would corrupt this; URLSearchParams handles it.
    const fields = { ...baseFields(), user: JSON.stringify({ id: 7, first_name: "A&B" }) };
    const initData = signHmacInitData(fields, BOT_TOKEN);
    const parsed = await verifyTelegramWebAppInitData(initData, BOT_TOKEN, { nowMs });
    expect(parsed.user?.first_name).toBe("A&B");
  });
});

describe("verifyTelegramWebAppInitDataSignature (Ed25519 third-party)", () => {
  test("accepts a real Ed25519 signature and rejects a tampered one", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyHex = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const botId = 424242;
    const fields = baseFields();
    const message = `${botId}:WebAppData\n${dataCheckString(fields, ["hash", "signature"])}`;
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, encoder.encode(message)));

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, value);
    params.set("signature", toBase64Url(signature));
    const initData = params.toString();

    const parsed = await verifyTelegramWebAppInitDataSignature(initData, botId, { publicKeyHex, nowMs });
    expect(parsed.user?.id).toBe(7);

    const tampered = initData.replace("query_id=AAExampleQueryId", "query_id=forged");
    await expect(verifyTelegramWebAppInitDataSignature(tampered, botId, { publicKeyHex, nowMs })).rejects.toThrow(/does not match/);
  });

  test("rejects initData with no signature field", async () => {
    await expect(verifyTelegramWebAppInitDataSignature("auth_date=1&user=%7B%7D", 1, { nowMs })).rejects.toThrow(/missing the signature/);
  });
});

describe("parseTelegramInitData", () => {
  test("parses fields without verifying", () => {
    const initData = signHmacInitData(baseFields(), BOT_TOKEN);
    const parsed = parseTelegramInitData(initData);
    expect(parsed.user?.username).toBe("will");
    expect(parsed.params.query_id).toBe("AAExampleQueryId");
  });
});
