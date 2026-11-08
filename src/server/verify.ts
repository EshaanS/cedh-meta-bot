// Discord interaction signature check: Ed25519 over (timestamp + raw body), using Node's built-in crypto.
import { createPublicKey, verify, type KeyObject } from "node:crypto";

const MAX_SKEW_SECONDS = 300;
const keys = new Map<string, KeyObject>();

function publicKey(hex: string): KeyObject {
  let key = keys.get(hex);
  if (!key) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("DISCORD_PUBLIC_KEY must be 64 hex characters");
    key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(hex, "hex").toString("base64url") }, format: "jwk" });
    keys.set(hex, key);
  }
  return key;
}

/** True only for a well-formed, valid signature with a timestamp within 5 minutes of now. */
export function verifyDiscordRequest(
  rawBody: string,
  signatureHex: string | null,
  timestamp: string | null,
  publicKeyHex: string,
  nowSeconds = Date.now() / 1000,
): boolean {
  if (!signatureHex || !timestamp || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
  try {
    return verify(null, Buffer.from(timestamp + rawBody), publicKey(publicKeyHex), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
