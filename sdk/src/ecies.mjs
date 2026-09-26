// DSX-ECIES-v1 — tee-core/src/ecies.rs ile bayt bayt aynı. Tarayıcı ve Node'da çalışır
// (AES-GCM için WebCrypto).
//
//   blob   = 0x01 || eph_pub (33, compressed) || nonce (12) || aes_gcm_ct || tag (16)
//   shared = ECDH(eph_sk, recipient_pk).x
//   key    = HKDF-SHA256(ikm = shared, salt = eph_pub || recipient_pub, info = "darkpool/ecies/v1")

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const VERSION = 0x01;
export const OVERHEAD = 1 + 33 + 12 + 16;
const INFO = new TextEncoder().encode("darkpool/ecies/v1");
const subtle = globalThis.crypto.subtle;

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function compressed(pub) {
  return secp256k1.Point.fromBytes(pub).toBytes(true);
}

async function aesKey(shared33, ephPub, recipientPub, usage) {
  const raw = hkdf(sha256, shared33.slice(1), concat(ephPub, recipientPub), INFO, 32);
  return subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/** @param recipientPub 33 ya da 65 baytlık secp256k1 public key */
export async function encrypt(recipientPub, plaintext, aad = new Uint8Array()) {
  const rpub = compressed(recipientPub);
  const eph = secp256k1.utils.randomSecretKey();
  const ephPub = secp256k1.getPublicKey(eph, true);
  const key = await aesKey(secp256k1.getSharedSecret(eph, rpub, true), ephPub, rpub, "encrypt");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext));
  return concat(Uint8Array.of(VERSION), ephPub, nonce, ct);
}

export async function decrypt(secretKey, blob, aad = new Uint8Array()) {
  if (blob.length < OVERHEAD) throw new Error("ciphertext malformed");
  if (blob[0] !== VERSION) throw new Error(`unsupported version ${blob[0]}`);
  const ephPub = blob.slice(1, 34);
  const nonce = blob.slice(34, 46);
  const rpub = secp256k1.getPublicKey(secretKey, true);
  const key = await aesKey(secp256k1.getSharedSecret(secretKey, ephPub, true), ephPub, rpub, "decrypt");
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, blob.slice(46)));
}

/** tee-core/src/reveal.rs `aead_seal/aead_open`: nonce(12) || ct || tag, anahtar HKDF(K_b, info). */
export async function openWithBatchKey(kb, info, sealed, aad) {
  const raw = hkdf(sha256, kb, undefined, new TextEncoder().encode(info), 32);
  const key = await subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: aad }, key, sealed.slice(12)),
  );
}

export { secp256k1 };
