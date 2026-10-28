import "dotenv/config";
import { getAssociatedTokenAddress, getAccount, burnChecked } from "@solana/spl-token";
import {
  AUTHORITY, LEDGER_PATH, parseAmount, parseRef, formatUnits, readMintInfo, connect, verifyMint, fetchMetadata,
  tokenLabel, clusterName, ledgerCheck, ledgerBegin, ledgerDone, loadAuthority, flag, die,
} from "./lib.mjs";

// Burns AMOUNT from the authority's own token account. Only run it after the matching real ECX withdrawal
// has been paid out from the reserve (this script cannot check the ECX side). REF is that withdrawal's
// ECX txid, or a unique label: each REF can be burned only once (see ledger.jsonl).
// Burning needs no mint authority, only the owner of the token account, which is the pinned key.
const allowPending = flag("--allow-pending");

let info, ref;
try {
  info = readMintInfo();
  ref = parseRef(process.env.REF);
  parseAmount(process.env.AMOUNT, info.decimals);
  ledgerCheck("burn", ref, { allowPending });
} catch (e) {
  die(e.message);
}

const connection = connect();
let mint, genesis, amount;
try {
  ({ mint, genesis } = await verifyMint(connection, info));
  amount = parseAmount(process.env.AMOUNT, mint.decimals);
} catch (e) {
  die(e.message);
}

const ata = await getAssociatedTokenAddress(mint.address, AUTHORITY);
let balance;
try {
  balance = (await getAccount(connection, ata)).amount;
} catch {
  die(`${AUTHORITY.toBase58()} has no token account for this mint: nothing to burn.`);
}
if (balance < amount) {
  die(`the balance is only ${formatUnits(balance, mint.decimals)}, cannot burn ${formatUnits(amount, mint.decimals)}.`);
}
const md = await fetchMetadata(info.mint).catch(() => null);

console.log(`\nBURN on ${clusterName(genesis)} (irreversible)`);
console.log(`  token:    ${tokenLabel(md, mint.address.toBase58())}  [${info.path}]`);
console.log(`  owner:    ${AUTHORITY.toBase58()}  token account ${ata.toBase58()}`);
console.log(`  amount:   ${formatUnits(amount, mint.decimals)} of balance ${formatUnits(balance, mint.decimals)}  (${amount} base units)`);
console.log(`  supply:   ${formatUnits(mint.supply, mint.decimals)} now -> ${formatUnits(mint.supply - amount, mint.decimals)} after`);
console.log(`  REF:      ${ref}  (the ECX withdrawal already paid out; verify it yourself)`);

const owner = await loadAuthority(); // pasting the key is the go-ahead

try {
  ledgerBegin("burn", ref, { cluster: clusterName(genesis), mint: info.mint, owner: AUTHORITY.toBase58(), amount: amount.toString() }, { allowPending });
} catch (e) {
  die(e.message);
}

let sig;
try {
  sig = await burnChecked(connection, owner, ata, mint.address, owner, amount, mint.decimals);
} catch (e) {
  die(`the transaction failed or its outcome is unknown: ${e.message}\nREF "${ref}" stays PENDING in ${LEDGER_PATH}. Check the chain before retrying.`);
}
ledgerDone("burn", ref, sig);

console.log(`\nBurned. Tx: ${sig}`);
console.log(`Token account: ${ata.toBase58()}`);
