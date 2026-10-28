// Shared helpers for the mint/burn/metadata scripts. Everything that can be checked offline is checked
// before any network call; the chain (not mint-info.json) is the source of truth for decimals, cluster
// and authorities; and the one key this repo signs with is pinned below.
import "dotenv/config";
import { readFileSync, existsSync, appendFileSync } from "fs";
import { createInterface } from "readline/promises";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey as toUmiPublicKey } from "@metaplex-foundation/umi";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { findMetadataPda, safeFetchMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { keyringEntry, loadSigner } from "./keyring.mjs";

// The single key that controls issuance: on-chain mint authority AND metadata update authority of both
// wbECX (EVHqNdzjCupKi4rQkbuYw52sa1m8A7jeUAMP23S9AVVq) and wECX (6ombVv3YMs9qpx1QkycD9XW8HKSfv7vGrCFX3cxCYMVY),
// verified on mainnet 2026-10-27. Every script signs as this key and refuses any other.
export const AUTHORITY = new PublicKey("6Av9JtnZGADBATo3uyLVC12XojJYKJhZxv578cJR2sKT");
export const AUTHORITY_NAME = "authority"; // its entry in keyring.json

export const U64_MAX = 2n ** 64n - 1n;
export const RPC_URL = process.env.RPC_URL || clusterApiUrl("mainnet-beta");
export const MINT_INFO_PATH = process.env.MINT_INFO_PATH || "mint-info.json";
export const LEDGER_PATH = process.env.LEDGER_PATH || "ledger.jsonl";
export const flag = (f) => process.argv.includes(f);

const GENESIS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};
export const clusterName = (genesisHash) => GENESIS[genesisHash] || `unknown cluster (${genesisHash})`;

export function die(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

// DECIMALS must be a plain integer: Number("abc") is NaN, which the token client encodes as 0 decimals,
// and decimals can never be changed afterwards.
export function parseDecimals(raw, fallback = 8) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^(0|[1-9]\d?)$/.test(String(raw))) throw new Error(`DECIMALS must be an integer, got "${raw}"`);
  const n = Number(raw);
  if (n > 18) throw new Error("DECIMALS above 18 is not supported");
  return n;
}

// Human units -> base units, strictly: digits with an optional fraction; no sign, exponent, hex/binary
// prefix, extra dots or leading zeros; never more fractional digits than the mint has (the old parser
// silently truncated, and BigInt("0x10") silently accepted hex); non-zero; must fit a u64.
export function parseAmount(raw, decimals) {
  const s = String(raw ?? "").trim();
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`AMOUNT must be a plain decimal number like 100 or 0.5, got "${raw}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`AMOUNT "${s}" has more than ${decimals} decimal places`);
  const base = BigInt(m[1] + frac.padEnd(decimals, "0"));
  if (base === 0n) throw new Error("AMOUNT must be greater than zero");
  if (base > U64_MAX) throw new Error("AMOUNT does not fit in 64 bits");
  return base;
}

export function formatUnits(base, decimals) {
  const s = base.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

// REF: the ECX txid (or another unique label) that a mint or burn settles. The ledger lets each REF be
// settled at most once per operation.
export function parseRef(raw) {
  if (!raw || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) {
    throw new Error(
      "REF is required: the ECX txid (or other unique reference) this action settles, 1-128 chars of A-Z a-z 0-9 . _ : -",
    );
  }
  return raw;
}

// Note: new PublicKey(undefined) does NOT throw (it yields the all-zero system address), so the type
// check here matters: without it an unset RECIPIENT would mint into the system program's token account.
export function parsePubkey(raw, name) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${name} is required (a base58 public key)`);
  try {
    return new PublicKey(raw.trim());
  } catch {
    throw new Error(`${name} is not a valid base58 public key`);
  }
}

export function readMintInfo(path = MINT_INFO_PATH) {
  if (!existsSync(path)) throw new Error(`No ${path}. Run: npm run create-mint (or point MINT_INFO_PATH at the right file)`);
  let info;
  try {
    info = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (typeof info.mint !== "string" || !Number.isInteger(info.decimals)) {
    throw new Error(`${path} is damaged (needs "mint" and an integer "decimals")`);
  }
  parsePubkey(info.mint, `${path} "mint"`);
  return { path, ...info };
}

export const connect = () => new Connection(RPC_URL, "confirmed");

// ---- on-chain checks ------------------------------------------------------------------------------

// The chain is the truth: the mint must exist under the classic token program, on the cluster the file
// says, with the decimals the file says. Returns the live Mint and the cluster's genesis hash.
export async function verifyMint(connection, info) {
  const label = info.path ?? "mint-info";
  const genesis = await connection.getGenesisHash();
  if (info.genesisHash && info.genesisHash !== genesis) {
    throw new Error(`${label} is for ${clusterName(info.genesisHash)} but RPC_URL is ${clusterName(genesis)}`);
  }
  if (!info.genesisHash) console.warn(`WARNING: ${label} has no genesisHash, so the cluster is not checked.`);
  let mint;
  try {
    mint = await getMint(connection, new PublicKey(info.mint), "confirmed", TOKEN_PROGRAM_ID);
  } catch (e) {
    throw new Error(`mint ${info.mint} not found as a classic SPL token on ${clusterName(genesis)} (${e.constructor.name})`);
  }
  if (mint.decimals !== info.decimals) {
    throw new Error(`${label} says ${info.decimals} decimals but the mint on-chain has ${mint.decimals}`);
  }
  return { mint, genesis };
}

// Minting and changing the authority need the on-chain mint authority to be the pinned key. (Burning
// and metadata updates do not: they are checked against the token-account owner / update authority.)
export function requireMintAuthority(mint) {
  if (!mint.mintAuthority) {
    throw new Error("this mint has no mint authority any more: nothing can be minted and the authority cannot change.");
  }
  if (!mint.mintAuthority.equals(AUTHORITY)) {
    throw new Error(
      `the mint authority on-chain is ${mint.mintAuthority.toBase58()}, not the pinned authority ${AUTHORITY.toBase58()}. ` +
        "These scripts only sign as the pinned key.",
    );
  }
}

// On-chain Metaplex metadata, or null if the mint has none. Used to show "wbECX" vs "wECX" in plans.
export async function fetchMetadata(mintAddress) {
  const umi = createUmi(RPC_URL);
  const md = await safeFetchMetadata(umi, findMetadataPda(umi, { mint: toUmiPublicKey(mintAddress) })[0]);
  if (!md) return null;
  const strip = (s) => s.replace(/\0+$/, "");
  return { name: strip(md.name), symbol: strip(md.symbol), uri: strip(md.uri), updateAuthority: md.updateAuthority, isMutable: md.isMutable };
}

export const tokenLabel = (md, address) => `${md ? `${md.symbol} ("${md.name}")` : "(no on-chain metadata)"}  ${address}`;

export const sigToBase58 = (sigBytes) => base58.deserialize(sigBytes)[0];

// Typed confirmation, used on top of the secret-key paste for the irreversible operations.
export async function confirm(lines, word = "yes") {
  console.log("\n" + lines.join("\n") + "\n");
  if (!process.stdin.isTTY) die("not a terminal: these scripts are interactive by design");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type "${word}" to continue: `);
  rl.close();
  if (answer.trim() !== word) die("aborted");
}

// ---- ledger ---------------------------------------------------------------------------------------
// One JSON line per state change, so a deposit/withdrawal REF is settled at most once. "pending" is
// written right before the transaction is sent: if the send fails or times out, the outcome is unknown
// and the REF stays blocked until a person has checked the chain (then --allow-pending).
export function ledgerEntries(path = LEDGER_PATH) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function ledgerCheck(op, ref, { allowPending = false, path = LEDGER_PATH } = {}) {
  const prior = ledgerEntries(path).filter((e) => e.op === op && e.ref === ref);
  const last = prior[prior.length - 1];
  if (last?.state === "done") throw new Error(`${op} for REF "${ref}" was already done (tx ${last.sig}). Refusing to do it twice.`);
  if (last?.state === "pending" && !allowPending) {
    throw new Error(
      `${op} for REF "${ref}" is PENDING: an earlier run did not finish. Check the chain for that transaction first; ` +
        "if it did not land, re-run with --allow-pending.",
    );
  }
}

export function ledgerBegin(op, ref, details, opts = {}) {
  ledgerCheck(op, ref, opts);
  const line = JSON.stringify({ t: new Date().toISOString(), op, ref, state: "pending", ...details });
  appendFileSync(opts.path ?? LEDGER_PATH, line + "\n", { mode: 0o600 });
}

export function ledgerDone(op, ref, sig, path = LEDGER_PATH) {
  appendFileSync(path, JSON.stringify({ t: new Date().toISOString(), op, ref, state: "done", sig }) + "\n", { mode: 0o600 });
}

// ---- signing --------------------------------------------------------------------------------------
// The only signer these scripts accept: keyring.json's "authority", which must be the pinned key.
// Pasting its secret key is the go-ahead for the transaction.
export async function loadAuthority() {
  let entry;
  try {
    entry = keyringEntry(AUTHORITY_NAME);
  } catch (e) {
    die(e.message);
  }
  if (entry.publicKey !== AUTHORITY.toBase58()) {
    die(`keyring.json lists "${AUTHORITY_NAME}" as ${entry.publicKey}, but these scripts are pinned to ${AUTHORITY.toBase58()}.`);
  }
  return loadSigner(AUTHORITY_NAME);
}
