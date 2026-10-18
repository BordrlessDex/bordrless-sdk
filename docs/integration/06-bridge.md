# 6. The bridge

The bridge holds SPL tokens, Token-2022 tokens and SOL, and issues Bordrless-standard tokens for them
one for one. Bridged SOL is every launch's `quote_mint` (in every pool's address), but since 15 Oct
2026 almost every pool holds its SOL natively, as lamports, and trades with `swap_v2` without the
bridge ([Trading](04-trading.md#native-sol-pools-swap_v2)).

## Bridged SOL

| | |
| --- | --- |
| Mint | `A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i` (`BRIDGED_SOL_MINT`) |
| Decimals | 9 |
| Backed by | Native SOL in the bridge's vault `["sol-vault"]` (`SOL_VAULT`) |
| Value | 1 bridged SOL = 1 SOL, always redeemable |

```ts
bridge.wrapSol(user, lamports);          // SOL -> bridged SOL (user's holding must exist: token.createHolding)
bridge.unwrapSol(user, amount);          // bridged SOL -> SOL; 2^64 - 1 unwraps all of it
bridge.unwrapSolAbove(user, keep);       // unwrap everything above `keep`
```

Only trades on a pool still on bridged SOL wrap before and unwrap after, in the same transaction
(pool `4PvPnTBy…`, coin `5DMBPNoY…`; [Trading](04-trading.md)); don't wrap for a native pool. A
wallet's bridged-SOL holding is its SOL: show it as SOL, and value it at 1:1.

## Bridged SPL and Token-2022 tokens

Any SPL or Token-2022 mint can be wrapped. Its Bordrless twin is
`wrappedMintAddress(underlying)` (`["wrapped", underlying]` under the bridge), with the same decimals,
and the bridge holds the originals in `bridgeVaultAddress(underlying, tokenProgram)`.

```ts
// Once per underlying mint, by anyone (the first wrap does it on the Bordrless site):
bridge.register(payer, underlying, underlyingTokenProgram, { name, symbol, uri });
// Then:
bridge.wrap(user, underlying, underlyingTokenProgram, userAta, amount);    // SPL -> Bordrless
bridge.unwrap(user, underlying, underlyingTokenProgram, userAta, amount);  // Bordrless -> SPL
```

The wrapper (`wrapperAddress(underlying)`, `decodeWrapper`) records `totalWrapped`. Every wrapped
token is backed one for one by the vault. A bridged token has no hook and trades in ordinary DEX
pools ([Trading](04-trading.md#ordinary-pools)).

Wrapping credits what actually arrived in the vault, so a Token-2022 transfer fee is paid on the
way in and on the way out. Token-2022 mints with a transfer hook can't be wrapped: the bridge passes no transfer-hook
accounts.

**Pricing a bridged token:** it's the underlying, one for one. If you already price the SPL mint,
use that price.
