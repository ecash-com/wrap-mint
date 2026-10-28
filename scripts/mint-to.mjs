import "dotenv/config";
import { getOrCreateAssociatedTokenAccount, mintToChecked } from "@solana/spl-token";
import {
  AUTHORITY, LEDGER_PATH, parseAmount, parseRef, parsePubkey, formatUnits, readMintInfo, connect, verifyMint,
  requireMintAuthority, fetchMetadata, tokenLabel, clusterName, ledgerCheck, ledgerBegin, ledgerDone,
  loadAuthority, flag, die,
} from "./lib.mjs";

// Mints AMOUNT to RECIPIENT. Only run it after the matching ECX deposit has been confirmed in the reserve
// (this script cannot check the ECX side). REF is that deposit's txid, or a unique label such as "seed-1"
// for deliberate liquidity seeding: each REF can be minted only once (see ledger.jsonl).
// Everything is validated before the secret key is requested; the chain decides decimals and authority.
const allowPending = flag("--allow-pending");

let info, recipient, ref;
try {
  info = readMintInfo();
  recipient = parsePubkey(process.env.RECIPIENT, "RECIPIENT");
  ref = parseRef(process.env.REF);
  parseAmount(process.env.AMOUNT, info.decimals); // fail fast, before any network call
  ledgerCheck("mint", ref, { allowPending });
} catch (e) {
  die(e.message);
}

const connection = connect();
let mint, genesis, amount;
try {
  ({ mint, genesis } = await verifyMint(connection, info));
  requireMintAuthority(mint);
  amount = parseAmount(process.env.AMOUNT, mint.decimals);
} catch (e) {
  die(e.message);
}
if (recipient.equals(mint.address)) die("RECIPIENT is the mint address itself (typo?).");
const md = await fetchMetadata(info.mint).catch(() => null);

console.log(`\nMINT on ${clusterName(genesis)}`);
console.log(`  token:      ${tokenLabel(md, mint.address.toBase58())}  [${info.path}]`);
console.log(`  recipient:  ${recipient.toBase58()}${recipient.equals(AUTHORITY) ? "  (the authority's own wallet)" : ""}`);
console.log(`  amount:     ${formatUnits(amount, mint.decimals)}  (${amount} base units)`);
console.log(`  supply:     ${formatUnits(mint.supply, mint.decimals)} now -> ${formatUnits(mint.supply + amount, mint.decimals)} after`);
console.log(`  REF:        ${ref}  (the ECX deposit this settles; verify it yourself)`);

const payer = await loadAuthority(); // pasting the key is the go-ahead

try {
  ledgerBegin("mint", ref, { cluster: clusterName(genesis), mint: info.mint, recipient: recipient.toBase58(), amount: amount.toString() }, { allowPending });
} catch (e) {
  die(e.message);
}

let sig, ata;
try {
  ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint.address, recipient);
  sig = await mintToChecked(connection, payer, mint.address, ata.address, payer, amount, mint.decimals);
} catch (e) {
  die(`the transaction failed or its outcome is unknown: ${e.message}\nREF "${ref}" stays PENDING in ${LEDGER_PATH}. Check the chain before retrying.`);
}
ledgerDone("mint", ref, sig);

console.log(`\nMinted. Tx: ${sig}`);
console.log(`Recipient token account: ${ata.address.toBase58()}`);
