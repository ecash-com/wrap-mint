import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MintLayout, MINT_SIZE, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  AUTHORITY, parseAmount, parseDecimals, formatUnits, parseRef, parsePubkey, readMintInfo, clusterName,
  verifyMint, requireMintAuthority, ledgerCheck, ledgerBegin, ledgerDone, ledgerEntries, sigToBase58,
} from "./lib.mjs";

const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "wecx-lib-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("parseAmount converts plain decimals to base units", () => {
  assert.equal(parseAmount("100", 8), 10000000000n);
  assert.equal(parseAmount("0.1", 8), 10000000n);
  assert.equal(parseAmount("0.00000001", 8), 1n);
  assert.equal(parseAmount(" 7 ", 8), 700000000n);
  assert.equal(parseAmount("184467440737.09551615", 8), 2n ** 64n - 1n);
  assert.equal(parseAmount("12", 0), 12n);
});

test("parseAmount rejects everything that is not a plain positive decimal", () => {
  const bad = ["0x10", "0b1", "1e3", "-5", "+5", "1.5.5", "5.", ".5", "1,5", "1_0", "00012", "", " ", "abc", "0", "0.0", "١٢", undefined, null];
  for (const b of bad) assert.throws(() => parseAmount(b, 8), undefined, `should reject ${JSON.stringify(b)}`);
});

test("parseAmount never truncates or overflows (the old parser did both silently)", () => {
  assert.throws(() => parseAmount("0.123456789", 8), /more than 8 decimal places/);
  assert.throws(() => parseAmount("1.5", 0), /more than 0 decimal places/);
  assert.throws(() => parseAmount("184467440737.09551616", 8), /64 bits/);
  assert.throws(() => parseAmount("99999999999999999999999", 8), /64 bits/);
});

test("parseDecimals is strict", () => {
  assert.equal(parseDecimals(undefined), 8);
  assert.equal(parseDecimals(""), 8);
  assert.equal(parseDecimals("6"), 6);
  assert.equal(parseDecimals("0"), 0);
  for (const b of ["abc", "NaN", "-1", "8.5", "08", "19", "300", " 8"]) {
    assert.throws(() => parseDecimals(b), undefined, `should reject ${JSON.stringify(b)}`);
  }
});

test("formatUnits round-trips parseAmount", () => {
  for (const s of ["100", "0.1", "0.00000001", "12.345", "184467440737.09551615"]) {
    assert.equal(formatUnits(parseAmount(s, 8), 8), s);
  }
  assert.equal(formatUnits(5n, 0), "5");
  assert.equal(formatUnits(0n, 8), "0");
});

test("parseRef requires a plain unique reference", () => {
  assert.equal(parseRef("a1b2-c3.d4:e5"), "a1b2-c3.d4:e5");
  for (const b of [undefined, "", "has space", "x".repeat(129), "new\nline", "semi;colon"]) {
    assert.throws(() => parseRef(b), undefined, `should reject ${JSON.stringify(b)}`);
  }
});

test("parsePubkey rejects missing or malformed keys (new PublicKey(undefined) would NOT throw)", () => {
  assert.equal(parsePubkey(` ${AUTHORITY.toBase58()} `, "X").toBase58(), AUTHORITY.toBase58());
  for (const b of [undefined, null, "", "  ", "not-a-key", "0x00", 42]) {
    assert.throws(() => parsePubkey(b, "RECIPIENT"), /RECIPIENT/, `should reject ${JSON.stringify(b)}`);
  }
});

test("readMintInfo validates the file", () =>
  withTmp((dir) => {
    const p = join(dir, "mi.json");
    assert.throws(() => readMintInfo(p), /No .*mi\.json/);
    writeFileSync(p, "{");
    assert.throws(() => readMintInfo(p), /not valid JSON/);
    writeFileSync(p, JSON.stringify({ mint: AUTHORITY.toBase58(), decimals: "8" }));
    assert.throws(() => readMintInfo(p), /damaged/);
    writeFileSync(p, JSON.stringify({ mint: "garbage", decimals: 8 }));
    assert.throws(() => readMintInfo(p), /not a valid base58 public key/);
    writeFileSync(p, JSON.stringify({ mint: AUTHORITY.toBase58(), decimals: 8, genesisHash: MAINNET }));
    const info = readMintInfo(p);
    assert.equal(info.decimals, 8);
    assert.equal(info.path, p);
  }));

test("clusterName knows the public clusters", () => {
  assert.equal(clusterName(MAINNET), "mainnet-beta");
  assert.equal(clusterName(DEVNET), "devnet");
  assert.match(clusterName("abc"), /unknown cluster \(abc\)/);
});

// A fake connection serving one hand-encoded SPL mint account: lets the on-chain checks run offline.
function fakeMint({ authority = AUTHORITY, decimals = 8, supply = 0n } = {}) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: authority ? 1 : 0,
      mintAuthority: authority ?? PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return { owner: TOKEN_PROGRAM_ID, data, lamports: 1, executable: false, rentEpoch: 0 };
}
const fakeConnection = (genesis, account) => ({ getGenesisHash: async () => genesis, getAccountInfo: async () => account });
const mintAddress = Keypair.generate().publicKey.toBase58();

test("verifyMint accepts a matching mint and returns the live account", async () => {
  const { mint, genesis } = await verifyMint(fakeConnection(MAINNET, fakeMint({ supply: 5n })), { mint: mintAddress, decimals: 8, genesisHash: MAINNET });
  assert.equal(genesis, MAINNET);
  assert.equal(mint.decimals, 8);
  assert.equal(mint.supply, 5n);
  assert.ok(mint.mintAuthority.equals(AUTHORITY));
});

test("verifyMint refuses the wrong cluster, a missing mint, or mismatched decimals", async () => {
  await assert.rejects(verifyMint(fakeConnection(MAINNET, fakeMint()), { mint: mintAddress, decimals: 8, genesisHash: DEVNET }), /is for devnet but RPC_URL is mainnet-beta/);
  await assert.rejects(verifyMint(fakeConnection(MAINNET, null), { mint: mintAddress, decimals: 8, genesisHash: MAINNET }), /not found as a classic SPL token/);
  await assert.rejects(verifyMint(fakeConnection(MAINNET, fakeMint({ decimals: 6 })), { mint: mintAddress, decimals: 8, genesisHash: MAINNET }), /says 8 decimals but the mint on-chain has 6/);
  await assert.rejects(verifyMint(fakeConnection(MAINNET, { ...fakeMint(), owner: Keypair.generate().publicKey }), { mint: mintAddress, decimals: 8, genesisHash: MAINNET }), /not found as a classic SPL token/);
});

test("requireMintAuthority only accepts the pinned key", async () => {
  const ok = (await verifyMint(fakeConnection(MAINNET, fakeMint()), { mint: mintAddress, decimals: 8 })).mint;
  assert.doesNotThrow(() => requireMintAuthority(ok));
  const other = (await verifyMint(fakeConnection(MAINNET, fakeMint({ authority: Keypair.generate().publicKey })), { mint: mintAddress, decimals: 8 })).mint;
  assert.throws(() => requireMintAuthority(other), /not the pinned authority/);
  const revoked = (await verifyMint(fakeConnection(MAINNET, fakeMint({ authority: null })), { mint: mintAddress, decimals: 8 })).mint;
  assert.throws(() => requireMintAuthority(revoked), /no mint authority any more/);
});

test("ledger settles a REF at most once per operation", () =>
  withTmp((dir) => {
    const path = join(dir, "ledger.jsonl");
    assert.doesNotThrow(() => ledgerCheck("mint", "tx1", { path }));
    ledgerBegin("mint", "tx1", { amount: "1" }, { path });
    // an unfinished run blocks the REF until a person has checked the chain
    assert.throws(() => ledgerCheck("mint", "tx1", { path }), /PENDING/);
    assert.throws(() => ledgerBegin("mint", "tx1", {}, { path }), /PENDING/);
    ledgerBegin("mint", "tx1", {}, { path, allowPending: true });
    ledgerDone("mint", "tx1", "SIG1", path);
    assert.throws(() => ledgerCheck("mint", "tx1", { path, allowPending: true }), /already done \(tx SIG1\)/);
    // other REFs and the other operation are independent
    ledgerBegin("mint", "tx2", {}, { path });
    ledgerBegin("burn", "tx1", {}, { path });
    assert.equal(ledgerEntries(path).filter((e) => e.state === "done").length, 1);
    assert.equal(ledgerEntries(path).length, 5);
  }));

test("signatures are printed in base58", () => {
  assert.equal(sigToBase58(new Uint8Array(64).fill(1)).slice(0, 12), "2AXDGYSE4f2s");
});
