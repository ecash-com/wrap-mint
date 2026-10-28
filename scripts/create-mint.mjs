import "dotenv/config";
import { createMint } from "@solana/spl-token";
import { existsSync, writeFileSync } from "fs";
import { AUTHORITY, MINT_INFO_PATH, parseDecimals, connect, clusterName, loadAuthority, flag, die } from "./lib.mjs";

let decimals;
try {
  decimals = parseDecimals(process.env.DECIMALS);
} catch (e) {
  die(e.message);
}

// A second run would overwrite the only local record of a live mint.
if (existsSync(MINT_INFO_PATH) && !flag("--force")) {
  die(`${MINT_INFO_PATH} already exists. Refusing to create another mint over it: point MINT_INFO_PATH at a new file, or pass --force.`);
}

const connection = connect();
const genesisHash = await connection.getGenesisHash();
const balance = await connection.getBalance(AUTHORITY);
if (balance === 0) die(`${AUTHORITY.toBase58()} has 0 SOL on ${clusterName(genesisHash)}. Fund it first.`);

console.log(`\nCREATE a new SPL mint on ${clusterName(genesisHash)}`);
console.log(`  decimals:         ${decimals} (permanent)`);
console.log(`  mint authority:   ${AUTHORITY.toBase58()} (can mint without limit; move it later with npm run set-authority)`);
console.log(`  freeze authority: none`);
console.log(`  record:           ${MINT_INFO_PATH}`);

// Freeze authority is intentionally null (no compliance reason to keep one). The mint authority starts as
// the pinned key; move it to a multisig (e.g. Squads) before going live with real liquidity.
const payer = await loadAuthority(); // pasting the key is the go-ahead
const mint = await createMint(connection, payer, AUTHORITY, null, decimals);

console.log(`\nMint created: ${mint.toBase58()}`);

// The cluster is recorded by genesis hash, not by RPC URL (URLs often embed an API key).
writeFileSync(
  MINT_INFO_PATH,
  JSON.stringify(
    {
      mint: mint.toBase58(),
      decimals,
      mintAuthority: AUTHORITY.toBase58(),
      freezeAuthority: null,
      genesisHash,
      cluster: clusterName(genesisHash),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Saved details to ${MINT_INFO_PATH}`);
