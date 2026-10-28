import "dotenv/config";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, signerIdentity, publicKey as toUmiPublicKey, percentAmount } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { createMetadataAccountV3 } from "@metaplex-foundation/mpl-token-metadata";
import {
  AUTHORITY, RPC_URL, readMintInfo, connect, verifyMint, requireMintAuthority, fetchMetadata, clusterName,
  sigToBase58, loadAuthority, die,
} from "./lib.mjs";

const { TOKEN_NAME, TOKEN_SYMBOL, METADATA_URI } = process.env;

// Metaplex limits: name 32, symbol 10, uri 200 bytes. Check up front for a clear message.
const bytes = (s) => Buffer.byteLength(s ?? "", "utf8");
if (!TOKEN_NAME || !TOKEN_SYMBOL) die("Set TOKEN_NAME and TOKEN_SYMBOL before running this.");
if (!METADATA_URI) die("Set METADATA_URI to a hosted JSON file (see config/token-metadata.json) before running this.");
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
  requireMintAuthority(mint); // createMetadataAccountV3 must be signed by the mint authority
} catch (e) {
  die(e.message);
}
const existing = await fetchMetadata(info.mint).catch(() => null);
if (existing) die(`this mint already has metadata ("${existing.name}" / ${existing.symbol}). Use npm run update-metadata instead.`);

console.log(`\nATTACH METADATA on ${clusterName(genesis)}`);
console.log(`  mint:    ${mint.address.toBase58()}  [${info.path}]`);
console.log(`  name:    ${TOKEN_NAME}   symbol: ${TOKEN_SYMBOL}`);
console.log(`  uri:     ${METADATA_URI}`);
console.log(`  update authority will be ${AUTHORITY.toBase58()} (mutable: name, symbol and uri can be changed later).`);

const web3Keypair = await loadAuthority(); // pasting the key is the go-ahead

const umi = createUmi(RPC_URL);
const signer = createSignerFromKeypair(umi, fromWeb3JsKeypair(web3Keypair));
umi.use(signerIdentity(signer));

const tx = await createMetadataAccountV3(umi, {
  mint: toUmiPublicKey(info.mint),
  mintAuthority: signer,
  payer: signer,
  updateAuthority: signer,
  data: {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    uri: METADATA_URI,
    sellerFeeBasisPoints: percentAmount(0),
    creators: null,
    collection: null,
    uses: null,
  },
  isMutable: true,
  collectionDetails: null,
}).sendAndConfirm(umi);

console.log(`\nMetadata attached. Signature: ${sigToBase58(tx.signature)}`);
