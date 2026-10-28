import "dotenv/config";
import { setAuthority, AuthorityType } from "@solana/spl-token";
import {
  AUTHORITY, parsePubkey, formatUnits, readMintInfo, connect, verifyMint, requireMintAuthority, fetchMetadata,
  tokenLabel, clusterName, confirm, loadAuthority, die,
} from "./lib.mjs";

// Moves the MINT authority to NEW_AUTHORITY (for example a Squads multisig vault), or revokes it for good
// with NEW_AUTHORITY=none (nothing can ever be minted again; irreversible). Afterwards mint-to and
// create-metadata refuse to run here for this mint, because these scripts only sign as the pinned key.
// The metadata update authority is a separate authority and is not touched.
let info, next;
try {
  info = readMintInfo();
  const raw = process.env.NEW_AUTHORITY;
  if (!raw) throw new Error('Set NEW_AUTHORITY to a base58 public key, or "none" to revoke minting forever.');
  next = raw === "none" ? null : parsePubkey(raw, "NEW_AUTHORITY");
} catch (e) {
  die(e.message);
}

const connection = connect();
let mint, genesis;
try {
  ({ mint, genesis } = await verifyMint(connection, info));
  requireMintAuthority(mint);
} catch (e) {
  die(e.message);
}
if (next?.equals(AUTHORITY)) die("NEW_AUTHORITY is already the current authority.");
const md = await fetchMetadata(info.mint).catch(() => null);

await confirm(
  [
    `CHANGE MINT AUTHORITY on ${clusterName(genesis)}`,
    `  token:  ${tokenLabel(md, mint.address.toBase58())}  [${info.path}]`,
    `  from:   ${AUTHORITY.toBase58()}`,
    next
      ? `  to:     ${next.toBase58()}\n          Check this address twice: if it is wrong, minting is lost or goes to a stranger.`
      : `  to:     NOBODY. Minting is permanently disabled; the supply (${formatUnits(mint.supply, mint.decimals)}) is fixed forever.`,
  ],
  next ? "yes" : "revoke",
);

const payer = await loadAuthority(); // pasting the key is the go-ahead
const sig = await setAuthority(connection, payer, mint.address, payer, AuthorityType.MintTokens, next);

console.log(`\nMint authority changed. Tx: ${sig}`);
if (next) console.log(`Future minting must be signed by ${next.toBase58()}; mint-to in this repo will refuse.`);
