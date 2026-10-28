import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Keypair } from "@solana/web3.js";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { parseSecret, readKeyring, writeKeyring, keyringEntry, promptHidden, short } from "./keyring.mjs";

const kp = Keypair.generate();
const pub = kp.publicKey.toBase58();
const jsonSecret = JSON.stringify(Array.from(kp.secretKey));

test("parseSecret accepts the JSON array that solana-keygen / the old generate-keypair wrote", () => {
  assert.equal(parseSecret(jsonSecret).publicKey.toBase58(), pub);
  assert.equal(parseSecret(`  ${jsonSecret}\r\n`).publicKey.toBase58(), pub, "surrounding whitespace is ignored");
});

test("parseSecret accepts base58: a 64-byte secret key or a 32-byte seed", () => {
  assert.equal(parseSecret(base58.deserialize(kp.secretKey)[0]).publicKey.toBase58(), pub);
  assert.equal(parseSecret(base58.deserialize(kp.secretKey.slice(0, 32))[0]).publicKey.toBase58(), pub);
});

test("parseSecret rejects bad input and never echoes it", () => {
  const marker = "SECRET-LOOKING-MARKER";
  const bad = ["", "   ", marker, `[${marker}]`, "[1,2,3]", "[1,2,300]", "[1.5,2]", "0x" + "ab".repeat(32), JSON.stringify(Array.from(kp.secretKey).slice(0, 63)), undefined, null];
  for (const b of bad) {
    assert.throws(() => parseSecret(b), (e) => !e.message.includes(marker), `should reject ${JSON.stringify(b)?.slice(0, 40)}`);
  }
  const tampered = Array.from(kp.secretKey);
  tampered[40] ^= 1; // public half no longer matches the secret half
  assert.throws(() => parseSecret(JSON.stringify(tampered)), /not a consistent ed25519 keypair/);
});

test("a valid but different key parses fine, so callers must compare the public key", () => {
  const other = Keypair.generate();
  assert.notEqual(parseSecret(JSON.stringify(Array.from(other.secretKey))).publicKey.toBase58(), pub);
});

test("keyring.json round-trips and is validated on read", () => {
  const dir = mkdtempSync(join(tmpdir(), "wecx-keyring-test-"));
  const path = join(dir, "keyring.json");
  try {
    assert.deepEqual(readKeyring(path), {}, "a missing file is an empty keyring");
    writeKeyring({ authority: { publicKey: pub, note: "test" } }, path);
    assert.equal(keyringEntry("authority", path).publicKey, pub);
    assert.equal(keyringEntry("authority", path).note, "test");
    assert.throws(() => keyringEntry("nope", path), /"nope" is not in/);
    writeKeyring({ bad: { publicKey: "not-a-key" } }, path);
    assert.throws(() => readKeyring(path), /invalid publicKey/);
    writeKeyring({ bad: {} }, path);
    assert.throws(() => readKeyring(path), /has no publicKey/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promptHidden refuses anything that is not a terminal", async (t) => {
  if (process.stdin.isTTY) return t.skip("stdin is a TTY in this run");
  await assert.rejects(promptHidden("x: "), /interactive terminal/);
});

test("short() abbreviates a public key", () => {
  assert.equal(short("6Av9JtnZGADBATo3uyLVC12XojJYKJhZxv578cJR2sKT"), "6Av9…2sKT");
});
