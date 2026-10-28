// Keyring: public keys are cached in keyring.json (safe to keep and to commit). Secret keys are never
// stored anywhere in this repo. When a script has to sign, it prints what it is about to do, then asks
// you to paste the secret key into the terminal (input hidden), checks that it belongs to the expected
// public key, keeps it in memory for that one run, and never prints or writes it. Deliberately manual.
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createInterface } from "readline";
import { Writable } from "stream";
import { pathToFileURL } from "url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { base58 } from "@metaplex-foundation/umi/serializers";

export const KEYRING_PATH = process.env.KEYRING_PATH || "keyring.json";
export const DEFAULT_SIGNER = "authority"; // the scripts are pinned to this entry (see lib.mjs AUTHORITY)

export const short = (pk) => `${pk.slice(0, 4)}…${pk.slice(-4)}`;

export function readKeyring(path = KEYRING_PATH) {
  if (!existsSync(path)) return {};
  let ring;
  try {
    ring = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  for (const [name, entry] of Object.entries(ring)) {
    if (typeof entry?.publicKey !== "string") throw new Error(`${path}: entry "${name}" has no publicKey`);
    try {
      new PublicKey(entry.publicKey);
    } catch {
      throw new Error(`${path}: entry "${name}" has an invalid publicKey`);
    }
  }
  return ring;
}

export function writeKeyring(ring, path = KEYRING_PATH) {
  writeFileSync(path, JSON.stringify(ring, null, 2) + "\n");
}

export function keyringEntry(name, path = KEYRING_PATH) {
  const entry = readKeyring(path)[name];
  if (!entry) throw new Error(`"${name}" is not in ${path}. Run: npm run keyring -- add ${name}`);
  return { name, ...entry };
}

// Accepts what solana-keygen / the old generate-keypair wrote (a JSON array of 64 bytes) or a base58
// string (a 64-byte secret key, or a 32-byte seed). Error messages never include the input.
export function parseSecret(text) {
  const s = String(text ?? "").trim();
  if (!s) throw new Error("nothing was pasted");
  let bytes;
  if (s.startsWith("[")) {
    let arr;
    try {
      arr = JSON.parse(s);
    } catch {
      throw new Error("not valid JSON (paste the whole array on one line)");
    }
    if (!Array.isArray(arr) || !arr.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new Error("the JSON is not an array of bytes 0-255");
    }
    bytes = Uint8Array.from(arr);
  } else {
    try {
      bytes = base58.serialize(s);
    } catch {
      throw new Error("not a JSON array and not valid base58");
    }
  }
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new Error(`expected 64 bytes (or a 32-byte seed), got ${bytes.length}`);
  }
  try {
    return bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
  } catch {
    throw new Error("those bytes are not a consistent ed25519 keypair");
  }
}

// Reads one line from the terminal without echoing it. Only a TTY is accepted, so a secret can never
// arrive through a pipe, a file or an environment variable.
export function promptHidden(question) {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("secret keys can only be pasted into an interactive terminal (stdin is not a TTY)"));
  }
  return new Promise((resolve) => {
    const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
    // Creating the interface puts the TTY into raw mode (kernel echo off). Do that BEFORE showing the
    // prompt, so nothing pasted after the prompt appears can ever be echoed.
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(question);
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\naborted\n");
      process.exit(130);
    });
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function fail(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

async function askSecret(question) {
  try {
    return parseSecret(await promptHidden(question));
  } catch (e) {
    fail(`${e.message}. Nothing was sent.`);
  }
}

// Public key of a keyring entry, for read-only preparation before the secret is requested.
export function signerPublicKey(name = DEFAULT_SIGNER) {
  try {
    return new PublicKey(keyringEntry(name).publicKey);
  } catch (e) {
    fail(e.message);
  }
}

// What the scripts call right before signing. Pasting the secret key is the go-ahead.
export async function loadSigner(name = DEFAULT_SIGNER) {
  let entry;
  try {
    entry = keyringEntry(name);
  } catch (e) {
    fail(e.message);
  }
  console.log(`\nSigner "${name}": ${entry.publicKey}${entry.note ? `\n  (${entry.note})` : ""}`);
  const kp = await askSecret(
    `Paste the secret key for ${short(entry.publicKey)} to SIGN AND SEND, then press Enter (input is hidden; Ctrl+C aborts): `,
  );
  const got = kp.publicKey.toBase58();
  if (got !== entry.publicKey) {
    fail(`that secret key belongs to ${got}, not to "${name}" (${entry.publicKey}). Nothing was sent.`);
  }
  console.log(`Secret key verified for ${short(got)}.`);
  return kp;
}

// ---- CLI: npm run keyring -- <list | add | verify | generate | remove> ---------------------------

const USAGE = [
  "usage: npm run keyring -- <command>",
  "  list                                   show the names and public keys in keyring.json",
  "  add <name> [public key] [--note text]  record a public key; without one, paste the secret and it is derived",
  "  verify <name>                          paste a secret key and check that it matches <name> (sends nothing)",
  "  generate <name> [--out path] [--note]  new keypair: public key saved, secret printed once (or written to --out)",
  "  remove <name>                          forget a public key",
  "  --force                                allow add/generate to replace an existing name",
].join("\n");

async function main(argv) {
  const [cmd, name, ...rest] = argv;
  const flag = (f) => argv.includes(f);
  const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const noteField = opt("--note") ? { note: opt("--note") } : {};
  const ring = readKeyring();

  switch (cmd) {
    case "list": {
      const names = Object.keys(ring);
      if (!names.length) return console.log(`${KEYRING_PATH} is empty. Run: npm run keyring -- add <name>`);
      for (const n of names) console.log(`${n.padEnd(14)} ${ring[n].publicKey}${ring[n].note ? `  ${ring[n].note}` : ""}`);
      return;
    }
    case "add": {
      if (!name) fail(USAGE);
      if (ring[name] && !flag("--force")) fail(`"${name}" is already in ${KEYRING_PATH} (${ring[name].publicKey}). Pass --force to replace it.`);
      const given = rest.find((a) => !a.startsWith("--") && a !== opt("--note"));
      let publicKey;
      if (given) {
        try {
          publicKey = new PublicKey(given).toBase58();
        } catch {
          fail(`"${given}" is not a valid base58 public key`);
        }
      } else {
        publicKey = (await askSecret(`Paste the secret key for "${name}", then press Enter (input is hidden): `)).publicKey.toBase58();
      }
      ring[name] = { publicKey, ...noteField };
      writeKeyring(ring);
      console.log(`Added "${name}" = ${publicKey} to ${KEYRING_PATH}. Only the public key was written.`);
      return;
    }
    case "verify": {
      if (!name) fail(USAGE);
      let entry;
      try {
        entry = keyringEntry(name);
      } catch (e) {
        fail(e.message);
      }
      const kp = await askSecret(`Paste the secret key you believe is "${name}" (${short(entry.publicKey)}), then press Enter (input is hidden): `);
      const got = kp.publicKey.toBase58();
      if (got !== entry.publicKey) fail(`MISMATCH: that secret key belongs to ${got}, not to "${name}" (${entry.publicKey}).`);
      console.log(`OK: that secret key is "${name}" (${entry.publicKey}).`);
      return;
    }
    case "generate": {
      if (!name) fail(USAGE);
      if (ring[name] && !flag("--force")) fail(`"${name}" is already in ${KEYRING_PATH} (${ring[name].publicKey}). Pass --force to replace it.`);
      const kp = Keypair.generate();
      const publicKey = kp.publicKey.toBase58();
      const out = opt("--out");
      if (out) {
        try {
          mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
          writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { flag: "wx", mode: 0o600 });
        } catch (e) {
          fail(e.code === "EEXIST" ? `${out} already exists; refusing to overwrite it` : e.message);
        }
      }
      ring[name] = { publicKey, ...noteField };
      writeKeyring(ring);
      console.log(`New keypair "${name}"\n  public key: ${publicKey}   (saved to ${KEYRING_PATH})`);
      if (out) {
        console.log(`  secret key: written to ${out} (mode 600). Move it to your safe place now. Nothing secret was printed.`);
      } else {
        console.log(`\n  SECRET KEY, shown once and stored nowhere by this tool. Copy it to your safe place NOW:`);
        console.log(`  JSON:   ${JSON.stringify(Array.from(kp.secretKey))}`);
        console.log(`  base58: ${base58.deserialize(kp.secretKey)[0]}`);
        console.log(`\n  Then clear this terminal. Scrollback may still hold it; close the tab if unsure.`);
      }
      console.log(`\nFund it before use.  Devnet: solana airdrop 2 ${publicKey} --url devnet   Mainnet: send SOL from a wallet you control.`);
      return;
    }
    case "remove": {
      if (!name || !ring[name]) fail(`"${name ?? ""}" is not in ${KEYRING_PATH}. Known: ${Object.keys(ring).join(", ") || "none"}`);
      delete ring[name];
      writeKeyring(ring);
      console.log(`Removed "${name}" from ${KEYRING_PATH} (only a public key; nothing secret was ever stored).`);
      return;
    }
    default:
      console.log(USAGE);
      if (cmd) process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
