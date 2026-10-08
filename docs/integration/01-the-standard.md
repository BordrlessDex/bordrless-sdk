# 1. The standard

What's on chain, and how it maps to what you already know from SPL.

## Tokens and holdings

| SPL | Bordrless | Notes |
| --- | --- | --- |
| Mint account (Token or Token-2022) | **`Mint`**, owned by the token program `2XoEW…vr22` | Name, symbol and metadata URI are stored **in the mint**. No Metaplex account to read. |
| Associated token account | **`Holding`** at `["holding", mint, owner]` under the token program | Exactly one per (mint, owner). `holdingAddress(mint, owner)`. |
| `getTokenAccountsByOwner` | `getProgramAccounts` on the token program, filtered by size and owner | See [Reading tokens](02-reading-tokens.md#a-wallets-balances). |
| Transfer hook (Token-2022) | **Token hook**, named on the mint | Runs *before* the transfer and can take part of it. See [Hooks](05-hooks-and-risk.md). |

A `Mint` holds `decimals`, `supply`, `maxSupply`, the authorities (mint, freeze, hook, metadata),
`hookProgram` and `hookFlags`, `name`, `symbol`, `uri`, `createdAt` and `creator`. Launchpad tokens
have 6 decimals and a supply of 1,000,000,000, and their mint authority is revoked at launch. The
URI points to Metaplex-style JSON (`name`, `symbol`, `description`, `image`, `extensions`,
`createdOn`).

A `Holding` holds `mint`, `owner`, `amount`, an optional `delegate` and `delegatedAmount`, `frozen`,
and **64 bytes of `hookData`** that only the mint's hook can write (for example, holder-reward
accounting or a Half-Life age). `token.createHolding(payer, mint, owner)` is idempotent; the rent is
about 0.0023 SOL. A holding can be closed with `close_holding` once it is empty and its hook data is
zero.

```ts
import { decodeHolding, decodeMint, holdingAddress } from '@bordrless/sdk';

const mint = decodeMint((await connection.getAccountInfo(mintKey))!.data);
const holding = await connection.getAccountInfo(holdingAddress(mintKey, owner));
const balance = holding ? decodeHolding(holding.data).amount : 0n; // raw units, `mint.decimals` places
```

## Pools

The Bordrless DEX runs constant-product pools with **virtual reserves**:

```
price (quote per base) = (quoteReserve + virtualQuote) / (baseReserve + virtualBase)
```

A pool is the PDA `poolAddress(baseMint, quoteMint, lpFeeBps, hookProgram)`. Its two vaults are
holdings owned by the pool (`vaultAddress(pool, mint)`). The `Pool` account keeps the real and
virtual reserves, the LP fee, the fee model, and running totals (`swapCount`, `baseVolume`,
`quoteVolume`, `lastSwapAt`).

A pool can have a **pool hook**, a program that runs on every swap and liquidity change. Every
launch pool has the launchpad as its pool hook, which applies the launch's fees.

Bordrless is paid in one of two ways, fixed per pool (`Pool.feeModel`):

- **Ordinary pools** (`FEE_MODEL_FLAT`): a flat `protocolFeeBps` of the quote side, 1% today.
- **Launch pools** (`FEE_MODEL_SHARE`): `protocolShareBps` (25%) of what the launch's rules and its
  token hook take on each swap, in SOL. A launch whose rules take nothing pays Bordrless nothing.

## Launches

A launch is the account `["launch", mint]` under the launchpad (`launchAddress(mint)`). It points
to its pool and keeps everything about the token's market:

- `pool`, `quoteMint` (always **bridged SOL**, 9 decimals; see [The bridge](06-bridge.md)), `status`
  (0 on the curve, 1 graduated);
- the curve: `virtualQuote`, `virtualBase`, `curveTokens` (750,000,000), `reserveTokens`
  (250,000,000), `graduationQuote`;
- fees: `lpFeeBps` (0.3%), `creatorFeeBps` (0–2%), and the sniper fee `sniperStartBps` (80%) falling
  linearly to `lpFeeBps` over `sniperWindowSecs` (30 s) after `createdAt`;
- the token rules (`rules`, `modules`) and an optional `customHook`;
- display totals: `creatorFeesAccrued`, `holderFeesAccrued`, `burnedOnTrades`.

**The curve and graduation.** 75% of the supply is sold on the curve. When the pool's real SOL
reserve reaches `graduationQuote`, or the curve has sold out (`baseReserve` 0), anyone can call
`graduate`. It tops the pool up from the 25%
reserve so the price stays continuous, burns the rest of the reserve, drops the virtual reserves,
and locks the LP tokens forever. **Trading continues in the same pool.** There's no migration and
no new address to follow.

## Programs

| Program | Address | Owns |
| --- | --- | --- |
| `bordrless_token` | `2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22` | `Mint`, `Holding` |
| `bordrless_swap` (DEX) | `GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk` | `Pool`, `Config` |
| `bordrless_launch` | `1jcBymHxBjniZDhNPy51Vgm5Nz7pLUdxa9UBHc4TavC` | `Launch`, `LaunchConfig`, `Config` |
| `bordrless_bridge` | `CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7` | `Wrapper`, `Config` |
| `bordrless_kit` | `14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH` | `KitConfig` |
| `half_life` | `53SpmtkdPWQ63mWoDeXk8P9tuwiT4ed2Wx4fwfy5NSF8` | `HalfLifeState` |

The same ids are used on devnet and localnet. `PROGRAM_IDS` in `@bordrless/shared` has them all.

## Account layouts

All accounts are Anchor accounts: an 8-byte discriminator, then the fields in IDL order, Borsh
encoded. Decode them with the SDK (`decodeMint`, `decodeHolding`, `decodePool`, `decodeLaunch`,
`decodeKitConfig`, `decodeWrapper`, `decodeHalfLifeState`) or with the IDLs in
[`packages/sdk/idl`](../../packages/sdk/idl).

| Account | Size | Discriminator (hex) | Fixed offsets for `memcmp` filters |
| --- | --- | --- | --- |
| `Mint` | 519 | `50bcf5145f8a399c` | `decimals` 9, `supply` 10 (u64) |
| `Holding` | 204 | `176040faebbf0090` | `mint` 10, `owner` 42, `amount` 74 (u64) |
| `Pool` | 411 | `f19a6d0411b16dbc` | `baseMint` 11, `quoteMint` 43 |
| `Launch` | 565 | `903333a3ce55d526` | `mint` 10, `creator` 42, `pool` 74, `status` 138 |
| `LaunchConfig` | 176 | `12a109e066911d5e` | |
| `KitConfig` | 431 | `bf93e526a1148293` | |
| `Wrapper` | | `a10b6d77563da388` | |
| `HalfLifeState` | | `2b0e53c31ce2df53` | |

Each program's own `Config` shares the discriminator `9b0caae01efacc82`; tell them apart by owner.
Use the offsets only for `getProgramAccounts` filters, and decode with the SDK or IDL, since fields
after an optional key move.

## Fixed addresses

| | Address | SDK |
| --- | --- | --- |
| Bridged SOL mint | `A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i` | `BRIDGED_SOL_MINT` |
| DEX config | `2XLvgczuVACmvvjfRLLAcLwMzFHutbAAro61zZKP8fsx` | `SWAP_CONFIG` |
| Launchpad config | `5n25iAaXFsjs4UgGQM6fCiRhaQcCVQ1L5BgyRZ7UrmaE` | `LAUNCH_CONFIG` |
| Bridge config | `Dwf4C8tTMYwicp8cU5MYcTtMQVVJTN7W3LcXCQ1UEhMs` | `BRIDGE_CONFIG` |
| Protocol lookup table (mainnet) | `4vxVcYLdkqT1rMfGHjAu4kMa9XSEhUdQU5ThVfU5grGQ` | addresses: `PROTOCOL_LOOKUP_TABLE` |

The lookup table holds the 18 fixed addresses every swap uses. Put it in every v0 transaction you
build. Measured on mainnet tokens, a buy or sell with SOL is 787–920 bytes with the table and
1,063–1,196 bytes without it, out of Solana's 1,232. Without the table there's no room left for a
priority fee, a graduation or a claim.
