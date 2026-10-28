# wecx-mint

The idea here is: enable liquidity for a brand new token.

This takes part in three steps:

1. Create **a solana token**, backed by ECX (or whatever new crypto).
2. Create **a swap server** which exchanges the token 1:1 for real ECX.
3. Create **a CPMM pool**, such as [Orca](https://www.orca.so/pools/7T4xAj1ENEuPckhWqz6nJP9ZkvDnFpVF7nLbUAvSwm43), such that USD-C can be traded for the solana token. (We recommend the Brave Browser.)

This repo covers only step 1. Another repo cover step 2. Step 3 is pretty easy -- it just requires (for example) the [Brave Browser](https://brave.com/download/) and visiting [Orca](https://www.orca.so/create-pool). 

This repo is a set of Node scripts, not a service. There is no deposit watcher or relayer.

Minting and burning are manual steps that you do only after checking the matching ECX deposit or withdrawal against your reserve.



## What's here

| Script                                               | Command                           | Purpose                                                                  |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| [keyring.mjs](scripts/keyring.mjs)                   | `npm run keyring -- <cmd>`        | Public-key keyring: `list`, `add`, `verify`, `generate`, `remove`        |
| [create-mint.mjs](scripts/create-mint.mjs)           | `npm run create-mint`             | Create the SPL mint (freeze authority = none) and write `mint-info.json` |
| [create-metadata.mjs](scripts/create-metadata.mjs)   | `npm run create-metadata`         | Attach Metaplex on-chain metadata (name, symbol, URI)                    |
| [update-metadata.mjs](scripts/update-metadata.mjs)   | `npm run update-metadata`         | Update that metadata later                                               |
| [mint-to.mjs](scripts/mint-to.mjs)                   | `npm run mint-to`                 | Mint tokens to a recipient wallet (needs a `REF`, recorded in the ledger) |
| [burn.mjs](scripts/burn.mjs)                         | `npm run burn`                    | Burn tokens from the authority's token account (needs a `REF`)           |
| [set-authority.mjs](scripts/set-authority.mjs)       | `npm run set-authority`           | Move the mint authority to a multisig, or revoke it for good             |
| [lib.mjs](scripts/lib.mjs)                           | `npm test`                        | Shared input checks, on-chain verification, REF ledger, pinned authority |

## The one key

Both tokens, **wbECX** (`EVHqNdzjCupKi4rQkbuYw52sa1m8A7jeUAMP23S9AVVq`) and **wECX**
(`6ombVv3YMs9qpx1QkycD9XW8HKSfv7vGrCFX3cxCYMVY`), have the same on-chain mint authority and metadata
update authority: `6Av9JtnZGADBATo3uyLVC12XojJYKJhZxv578cJR2sKT`. That address is pinned as `AUTHORITY` in
[lib.mjs](scripts/lib.mjs) and listed as `authority` in `keyring.json`. Every script signs as that key and
refuses any other; `mint-to` and `set-authority` also refuse a mint whose on-chain authority is not that key.
If the authority ever moves (e.g. to a multisig), update the pin.

## Setup

```bash
npm install
npm run keyring -- add authority      # paste the existing secret key once (hidden); only the PUBLIC key is saved
# or, for a brand-new key:
npm run keyring -- generate <name>    # saves the public key; prints the secret once (or writes it with --out <path>)
```

Requires Node.js with ES module support. The scripts use top-level `await`, so use a
current LTS release. Fund the keypair's public key with SOL before running anything that sends a
transaction.

### Signing keys: nothing secret on disk

- `keyring.json` holds **public keys only** (a name, the address, a note). It is safe to keep and to commit.
- No script reads a secret key from a file or from the environment. When a script needs to sign it prints
  what it is about to do and which key it expects, then asks you to **paste the secret key into the
  terminal**. Input is hidden; both the JSON byte array (the `authority.json` format) and base58 are
  accepted. The pasted key is checked against the public key in the keyring and, if it matches, used in
  memory for that one run. A wrong key, or anything that is not an interactive terminal, stops the script
  before anything is sent.
- The scripts always sign as `authority` (see "The one key" above). `npm run keyring -- verify authority`
  checks a stored copy of the secret without sending anything.
- This is deliberately slow: every transaction needs a person with the secret key at the terminal. There
  is no non-interactive mode. `set-authority` additionally asks you to type a confirmation word.

## Usage

**The scripts default to Solana mainnet-beta and spend real SOL.** To test on devnet, set
`RPC_URL=https://api.devnet.solana.com` on each command. Every command below prints its plan and then
waits for you to paste the signer's secret key.

```bash
# 1. Create the mint (8 decimals by default). Refuses to overwrite an existing MINT_INFO_PATH (--force).
npm run create-mint

# 2. Attach metadata (host the JSON first; see config/dev-token-metadata.json for the shape)
TOKEN_NAME=<name> TOKEN_SYMBOL=<symbol> METADATA_URI=https://your-host/token-metadata.json npm run create-metadata

# 3. Mint AMOUNT to RECIPIENT. REF = the ECX deposit txid this settles (each REF can be minted only once).
RECIPIENT=<wallet address> AMOUNT=100 REF=<ecx txid> npm run mint-to

# Burn tokens from the authority's own token account (e.g. after paying out a matching ECX withdrawal).
AMOUNT=100 REF=<ecx txid> npm run burn

# Move the mint authority to a multisig vault, or give it up for good:
NEW_AUTHORITY=<multisig vault address> npm run set-authority
NEW_AUTHORITY=none npm run set-authority      # irreversible: the supply becomes fixed

# The default mint-info.json is wbECX. For wECX:
MINT_INFO_PATH=mint-info-wecx.json AMOUNT=100 REF=<ecx txid> npm run burn
```

Every script that sends a transaction first checks the mint **on-chain** (it exists under the SPL Token
program, on the cluster `mint-info*.json` records by genesis hash, with the recorded decimals, and with the
pinned key as authority where that matters), prints what it is about to do, including the token symbol
and the supply before and after, and only then asks for the secret key. `AMOUNT` must be a plain decimal
such as `100` or `0.5` with no more decimal places than the mint has; nothing is truncated. `mint-to` and
`burn` append to `ledger.jsonl` (a `pending` line right before sending, `done` after) and refuse a `REF`
that was already settled or whose earlier run did not finish; if you have checked the chain and that
transaction never landed, pass `--allow-pending`, e.g. `npm run mint-to -- --allow-pending`.

### Configuration

Set these as environment variables. A `.env` file also works, since `dotenv` is loaded.

| Variable                      | Used by                              | Default                                                          |
| ----------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `RPC_URL`                     | all scripts                          | mainnet-beta public RPC                                          |
| `KEYRING_PATH`                | all scripts that sign                | `keyring.json`                                                   |
| `MINT_INFO_PATH`              | mint, metadata, mint-to, burn, set-authority | `mint-info.json` (= wbECX; `mint-info-wecx.json` = wECX) |
| `LEDGER_PATH`                 | `mint-to`, `burn`                    | `ledger.jsonl` (use a separate file for devnet tests)            |
| `DECIMALS`                    | `create-mint`                        | `8` (integer; permanent once the mint exists)                    |
| `METADATA_URI`                | `create-metadata`, `update-metadata` | none, required (≤ 200 bytes)                                     |
| `TOKEN_NAME`, `TOKEN_SYMBOL`  | `create-metadata`, `update-metadata` | none, required (≤ 32 / ≤ 10 bytes)                               |
| `RECIPIENT`                   | `mint-to`                            | none, required                                                   |
| `AMOUNT`                      | `mint-to`, `burn`                    | none, required (human units, plain decimal)                      |
| `REF`                         | `mint-to`, `burn`                    | none, required (the ECX txid being settled; unique per action)   |
| `NEW_AUTHORITY`               | `set-authority`                      | none, required (a public key, or `none`)                         |
| `TOKEN_AMOUNT`, `USDT_AMOUNT` | `create-pool`                        | none, required (human units; their ratio sets the initial price) |
| `USDT_MINT`, `USDT_DECIMALS`  | `create-pool`                        | real mainnet USDT / `6`. `USDT_MINT` is required on devnet       |
| `POOL_ID`                     | `lock-liquidity`                     | `poolId` from `pool-info.json`                                   |

### Local files

`keyring.json` is **not** gitignored: it holds only public keys and should be committed.

These are gitignored:

- `keys/`: no longer used by any script. Secret keys are pasted at run time, not stored here. Still ignored in case old files remain. **Never commit or share a secret key.**
- `mint-info.json`: the mint address, decimals, authority and cluster (genesis hash). `create-mint` writes it and refuses to overwrite it; the scripts re-check it against the chain.
- `mint-info-*.json`: optional separate mint records selected with `MINT_INFO_PATH`.
- `ledger.jsonl`: every mint/burn `REF`, its state and transaction. Keep it; back it up.
- `pool-info.json`, `lock-info.json`: pool and LP-lock details. Publish the lock proof.
- `.env`

## Before production:

- **Move the mint authority to a multisig** (e.g. Squads) with `npm run set-authority` before seeding
  real liquidity, or revoke it if the supply is meant to be fixed. A single key that can mint is a
  single point of failure for the peg. The metadata update authority is separate and is not moved by
  that script.
- **Back every mint with reserved ECX.** `mint-to` checks nothing on the ECX side. That check is up
  to you.
- The canonical token identifier is the **mint address**, not the symbol. Expect copycat tokens.
  Publish the full address.

## Status

Done: mint creation, metadata, mint/burn, authority transfer/revocation, paste-at-runtime signing with a public-key keyring pinned to the authority, strict input and on-chain checks, a REF ledger, unit tests (`npm test`).

Not built yet: the ECX deposit watcher / mint relayer, the burn/redeem workflow, moving the metadata update authority, and tests that send real transactions.
