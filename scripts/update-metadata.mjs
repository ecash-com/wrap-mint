import "dotenv/config";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, signerIdentity, publicKey as toUmiPublicKey, percentAmount } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { updateV1 } from "@metaplex-foundation/mpl-token-metadata";
import { AUTHORITY, RPC_URL, readMintInfo, connect, verifyMint, fetchMetadata, clusterName, sigToBase58, loadAuthority, die } from "./lib.mjs";

const { TOKEN_NAME, TOKEN_SYMBOL, METADATA_URI } = process.env;

// Metaplex limits: name 32, symbol 10, uri 200 bytes. Check up front for a clear message.
const bytes = (s) => Buffer.byteLength(s ?? "", "utf8");
if (!TOKEN_NAME || !TOKEN_SYMBOL) die("Set TOKEN_NAME and TOKEN_SYMBOL before running this.");
if (!METADATA_URI) die("Set METADATA_URI to the hosted JSON file (see config/token-metadata.json) before running this.");
if (bytes(TOKEN_NAME) > 32) die("TOKEN_NAME is longer than 32 bytes.");
if (bytes(TOKEN_SYMBOL) > 10) die("TOKEN_SYMBOL is longer than 10 bytes.");
if (bytes(METADATA_URI) > 200) die("METADATA_URI is longer than 200 bytes.");

let info;
try {
  info = readMintInfo();
} catch (e) {
  die(e.message);
}

let mint, genesis;
try {
  ({ mint, genesis } = await verifyMint(connect(), info));
} catch (e) {
  die(e.message);
}
// Updating needs the metadata UPDATE authority (separate from the mint authority), which must be the pinned key.
const current = await fetchMetadata(info.mint).catch(() => null);
if (!current) die("this mint has no metadata yet. Use npm run create-metadata instead.");
if (!current.isMutable) die("this mint's metadata is immutable; it cannot be updated.");
if (current.updateAuthority !== AUTHORITY.toBase58()) {
  die(`the metadata update authority on-chain is ${current.updateAuthority}, not the pinned authority ${AUTHORITY.toBase58()}.`);
}

console.log(`\nUPDATE METADATA on ${clusterName(genesis)}`);
console.log(`  mint:    ${mint.address.toBase58()}  [${info.path}]`);
console.log(`  name:    "${current.name}" -> "${TOKEN_NAME}"`);
console.log(`  symbol:  ${current.symbol} -> ${TOKEN_SYMBOL}`);
console.log(`  uri:     ${current.uri}\n        -> ${METADATA_URI}`);

const web3Keypair = await loadAuthority(); // pasting the key is the go-ahead

const umi = createUmi(RPC_URL);
const signer = createSignerFromKeypair(umi, fromWeb3JsKeypair(web3Keypair));
umi.use(signerIdentity(signer));

// updateV1 replaces the whole Data struct when `data` is provided: every field is resent, not just the
// one that changed. `authority` must be the current update authority.
const tx = await updateV1(umi, {
  mint: toUmiPublicKey(info.mint),
  authority: signer,
  data: {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    uri: METADATA_URI,
    sellerFeeBasisPoints: percentAmount(0),
    creators: null,
  },
}).sendAndConfirm(umi);

console.log(`\nMetadata updated. Signature: ${sigToBase58(tx.signature)}`);
