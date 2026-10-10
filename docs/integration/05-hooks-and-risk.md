# 5. Hooks and what to show users

A Bordrless token can run a **token hook**: a program called before (and, by its flags, after)
every transfer, mint and burn. It can refuse the operation, take up to three cuts from the amount,
and keep 64 bytes of state in every holding. Every launch pool also runs the launchpad as its
**pool hook**, which applies the launch's fees on each swap. A terminal should tell users which hook
a token runs, because that's what decides whether a transfer can be taxed or refused.

## Which hook a token runs

Read it from the mint (`hookProgram`, `hookFlags`, `hookAuthority`) and the launch (`modules`,
`customHook`):

| Case | How to tell | What it can do | Show |
| --- | --- | --- | --- |
| **No token hook** | `mint.hookProgram === null` | Nothing. Plain token | — |
| **The kit** (Bordrless launch rules) | `hookProgram` is the kit `14RJQX…aEH` and `isVerifiedKitToken(mintKey, mint, launch, kitConfig)` | Only the rules fixed at launch, below | The rules |
| **Half-Life** (Bordrless's own hook) | `hookProgram` is `53Spmtk…NSF8` | An exit fee on transfers out, burned. No refusals | The holder's current exit fee |
| **Lottery hook** (Bordrless's own game hook) | `hookProgram` is `HqFWsC…GWcr` | Keeps ticket ranges in hook data. Never refuses a transfer, takes no cut, never sees SOL | "Lottery coin" and the game ([below](#game-coins)) |
| **A game coin's Studio hook** (jackpot, streak) | `launch.customHook` is `companion.gameHook` of a [companion launch](02-reading-tokens.md#creators-that-are-programs-companions) | Keeps game state in hook data. Takes no cut (flags 145). Per-coin code: treat a refusal as possible | "Jackpot coin" / "Streak coin" and the game |
| **A custom hook** | any other `hookProgram` (a Studio hook, or anyone's) | Anything: refuse transfers (a honeypot), take cuts | Its [risk label](#risk-labels), the program, and [who can upgrade it](#who-can-upgrade-a-hook) |

For any hooked token, also check `mint.hookAuthority`. **`null` means the mint can never be pointed
at another hook program.** Otherwise someone can swap the hook later. Launchpad tokens always have
it `null`. Whether the hook program's own code can change is the next question.

## Who can upgrade a hook

A hook program that someone can upgrade can be swapped for other code after launch, whatever the
mint says. The launchpad and the companion take a custom hook (a `LaunchConfig` naming one fails
with `HookUpgradeable` otherwise) only if it is one of:

- **immutable**;
- upgradeable **only by Bordrless**: Bordrless Studio's key `CS1NRyXNCPxEUP4CRoa26cHQSeSJCxXh5SPijwFhDW6W`
  or the protocol's `5xsibKwtiN6ruxsYrEyWVpV3KcwuzSPbQd1n28a7spEd` (`HOOK_UPGRADE_AUTHORITIES` in
  `@bordrless/shared`);
- **timelocked** (since 2026-10-10): its upgrade authority is its `Timelock` account in Bordrless's
  `hook_timelock` program `BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ`. Its author can only propose
  new code by hash, public on chain, and execute it after the delay (at least 3 days; it can be
  lengthened, never shortened), or finalize the hook to immutable. The launchpad also refuses a
  timelocked hook while it has a proposal pending.

The check runs when the config is made, not at each launch, and a proposal can be made after a
launch. So read it yourself for every token, with the risk label below.

| Upgrade authority | Show |
| --- | --- |
| none (`upgradeable === false`) | "Immutable hook" |
| its `Timelock` | "Timelocked: its author can change it with N days' notice", and any pending proposal **prominently** |
| Studio's key | "Built with Bordrless Studio; Bordrless can upgrade it" (only when Studio attests it, below) |
| the protocol's key | Bordrless's own hooks (the kit, Half-Life, the lottery hook, `tax_hook`): "Upgradeable by Bordrless" |
| anyone else | A warning: whoever holds that key can change the hook at any time |
| unknown | Treat as upgradeable |

## Risk labels

`hookRiskLabel` gives one label per hook, the same words Bordrless's own site shows. Use it rather
than reading the upgrade authority alone:

```ts
import { decodeMint, hookRiskLabel } from '@bordrless/sdk';

const hookProgram = decodeMint((await connection.getAccountInfo(mint))!.data).hookProgram!; // a launch's: launch.customHook
const label = await hookRiskLabel(connection, hookProgram, { mint });
// label.class:    'immutable' | 'timelocked' | 'managed' (Bordrless can change it) | 'author' (its owner can, any time) | 'missing'
// label.severity: 'low' | 'medium' | 'high'
// label.words:    one sentence to show, e.g. "Its author can change this code with 3 days of public notice. Checked automatically by Studio, not audited."
// label.pending:  { hash, eta, buffer } when a timelocked hook has new code proposed
```

It costs two `getMultipleAccounts`, plus a download of the code only when an audit or attestation
needs its hash compared (cached by deploy slot). Passing `mint` also classes every program the
hook's registry lets it call; the label takes the weakest of them and names it.

- **`severity: 'high'`** (show a warning): its owner can change the code at any time; a proposal is
  pending (`words` says when it goes live); Bordrless blocked the game; or the hook is refused.
- **`audited: 'current'`**: Bordrless recorded an audit **of this exact code** (by hash). An audit
  goes `'stale'` the moment the code changes. No hook has had a third-party audit yet.
- **`provenance: 'studio'`** and `studio.current`: Bordrless Studio built this exact code from
  source and its automatic checks passed (a `HookAttestation` from Studio's attester
  `3uGLsTJNse7vE3pgRkAf6aKKBoKmCyPUcNNu1bw3KvP2`). It is not an audit. A program merely upgradeable
  by Studio's key, without an attestation, reads "not built by Studio": anyone can hand a program's
  upgrade authority to that key.
- **`potCap`**: for a game or strategy coin, the most its pot may hold (10 SOL until its hook has a
  current audit; `null` means uncapped).

Index the `hook_timelock` program's events (`anyProgramNameOf` names it `hookTimelock`) to alert
holders when a proposal lands: `UpgradeProposed` (the new code's hash and when it can execute),
`UpgradeCancelled`, `UpgradeExpired`, `Upgraded`, `DelayLengthened`, `Finalized`.

`inspectTokenHook(connection, program, mint)` reads the same plus the hook's registry in one call.

**Studio hooks.** Bordrless Studio lets anyone write a token hook with an AI assistant; Studio
builds and deploys it as its own program, and the creator never gets its upgrade authority.
Studio's review before a deploy is automatic and is not a guarantee of the code: a Studio hook may
refuse transfers (a cooldown) or take cuts (a sell tax) like any custom hook. Show what it does
from simulation and its `Transferred` cuts, never as vetted by Bordrless.

## The kit's rules

Fixed at launch, in `launch.rules` (`modules` says which are on: 1 holder rewards, 2 max wallet,
4 creator lock, 8 early-buyer lock):

| Rule | Field | Effect on a trade |
| --- | --- | --- |
| Holder rewards | `holderFeeBuyBps`, `holderFeeSellBps` | A share of each trade, in SOL, to holders pro rata; holders claim it any time |
| Burn | `burnBuyBps`, `burnSellBps` | A share of the tokens bought or sold is burned (a pool-hook rule; works with any token hook) |
| Max wallet | `maxWalletBps` (`kit.maxWalletAmount` in tokens) | No wallet may hold more until graduation. Buys above it fail with `MaxWalletExceeded` |
| Creator wallet lock | `launch.creatorUnlockAt` | The creator's wallet can't sell or send before then: `CreatorLocked` |
| Early-buyer lock | `launch.earlyWindowEnd`, `launch.earlyUnlockAt` | Tokens bought before `earlyWindowEnd` can't move before `earlyUnlockAt`: `EarlyLocked` |

All of these are taken by the program and included in `quoteLaunchSwap`
([Trading](04-trading.md)). Creator fee + holder rewards + burn is at most 3% per side.

**Holder rewards** are paid in bridged SOL. What a holder can claim:
`rewardsClaimable(kitRewardsOf(kitConfig), vaultAmount, now, holding.amount, kitHookDataOf(holding), kitExcludes(kitConfig, owner)).payable`
from `@bordrless/shared` and the SDK (`vaultAmount` is the balance of the reward vault
`launch.holderVault`; `kitConfig` is `decodeKitConfig` of `launch.kitConfig`). Claim with
`kit.claim(owner, mint, kitConfig.rewardMint)`, then
`bridge.unwrapSolAbove(owner, before)` for SOL.

## Half-Life

Each holding of a Half-Life token remembers when its tokens arrived, in its hook data: `"HL"`,
layout 1, then the unix time. Moving tokens out of a wallet (a sell, or a send) costs:

```
20%, halving every 6 hours held, falling in a straight line within each 6 hours, 0% from 48 hours
```

Buys are free. Tokens sent wallet to wallet keep the sender's age, and buying more averages a
wallet's age by weight. The fee is taken from the tokens moved, into the token's furnace, and anyone
can burn the furnace with `halfLife.stoke(mint)`.

**Show each holder their exit fee**, from [`wallet-holdings.ts`](../../examples/wallet-holdings.ts):

```ts
import { halfLifeSince } from '@bordrless/sdk';
import { halfLifeFeePpm } from '@bordrless/shared';

const since = halfLifeSince(holding.hookData);              // null if never stamped
const feePpm = since === null ? 200_000 : halfLifeFeePpm(now - since);
// A sell of `amount` gives the pool amount - amount * feePpm / 1e6 tokens.
```

On a sell the DEX also counts the fee as a cut and takes Bordrless's 25% share of its value in SOL
from the proceeds. So `quoteLaunchSwap(pool, 'sell', amount - fee, …)` overstates the SOL out by that
share. **Simulate a Half-Life sell for the exact figure** ([Trading](04-trading.md#quoting-exactly)).
Full details are in [Half-Life](https://github.com/BordrlessDex/bordrless-programs/tree/main/programs/half_life).

## Game coins

A game coin's creator is a [companion](02-reading-tokens.md#creators-that-are-programs-companions)
running a lottery, a jackpot or a streak, paid in SOL from its pot. A lottery coin's token hook is
Bordrless's lottery hook; a jackpot or streak coin's is a hook Studio deployed for that coin. A
companion takes a game hook only if it is the lottery hook, has a status from the protocol, or is
upgradeable only by Bordrless's keys, and never a blocked one. A game's pot is capped at 10 SOL
unless the protocol's `HookStatus` for its hook says otherwise
([Game coins](02-reading-tokens.md#game-coins)).

Lottery coins launch from one of three `LaunchConfig`s the protocol made on mainnet, each naming
the lottery hook with flags 145 and no token rules (`LOTTERY_HOOK.launchConfigs` in
`@bordrless/shared`; `launch.config` says which):

| Creator fee | `LaunchConfig` |
| --- | --- |
| 0.5% | `CYm9FNY49gV7wjukpYFqkm9u7FQLrjp2GexeHwbncf1L` |
| 1% | `GViQSt6znkGdiCrUYNTo3dJKMgfGS8eBHPSBjxfN2VS9` |
| 2% | `Ejo4Ehg4x16MeBKn3Y2f1NU31CoBjnby4kv75azUD8hU` |

Trading one is trading any custom-hook token: `fetchCustomHookAccounts` resolves the hook's
registry (its state, writable, and the launch), or without a read, `lotteryHook.accounts(mint)` and
`studioGameHook.accounts(game.hook, mint)`. Every transfer of the coin write-locks the hook's state.

**What to warn holders about.** Sending is part of the game:

- **Jackpot:** the last buyer is paid only if they still hold what they bought and have **sent
  nothing** since (selling even one token, or a transfer to another wallet, forfeits the round).
- **Streak:** **any send**, to anyone (your own wallets too), forfeits the epoch's share and the
  last epoch's unclaimed share. Claim before sending.
- **Lottery:** tokens bought or received during a round count from the next round; selling cuts the
  holding's tickets.

**What a wallet can offer.** Every game step is permissionless (any fee payer may send it) and
Bordrless's keeper sends them, prizes included; these are optional actions a holder may take
themselves:

```ts
import { companion, lotteryHook, studioGameHook } from '@bordrless/sdk';

lotteryHook.enter(mint, owner);                    // lottery: register this round's tickets now (no signer; the fee payer sends it)
studioGameHook.enter(game.hook, mint, owner);      // streak: register for the epoch
companion.claimShare(owner, mint, game.hook, game.round, owner); // streak: claim the open epoch's share, paid in SOL
```

A lottery holding that hasn't traded in a round has tickets in it only once someone enters it
(the keeper enters holders late each round). A streak claim is open for the closed epoch (`game.round`
while `game.status` is `'revealed'`): `streakWeight` and `shareOf` say what it pays, and the sender
pays a receipt's rent (1,767,840 lamports), returned by `companion.closeReceipt` once the claims
end. The protocol's keeper claims a share for a holder only when the sender's bounty covers its
cost (a bounty of at least 50,000 lamports, or a share of at least 0.05 SOL); a smaller share is
the holder's to claim. Rules, timings and every edge case: [docs/games.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/games.md).

## Strategy coins and the hook vault

**Strategy coins** (since 2026-10-10) are companion game coins whose payouts an author's program
decides (`GameKindSet` with the strategy kind; `StrategySet` names the program). Each period the
companion asks the strategy program for a budget and each holder's entitlement, then pays them in
SOL, capped by the companion (a budget share per period and a maximum share per holder) and by the
pot cap. Label them "Strategy coin" and show the strategy program's [risk label](#risk-labels): its
author decides who is paid, within those caps. Design:
[strategies.md](https://github.com/BordrlessDex/bordrless-programs/blob/main/docs/strategies.md).

**The hook vault** `5cojoUStG7WFhHJiSncCUEwTqDuhDLKu4a9BqTbF8jzG` holds a hook's cut of a token in up
to three slots, each with a policy fixed before launch: burn, sell for SOL to a fixed wallet, or
sell and buy and burn another token (`decodeVault`, `VAULT_POLICY`). Each slot holds tokens in a
holding owned by `slotOwner(mint, i)`. **Label those holdings "Hook vault", not as holders**; they
are tokens on their way to being burned or sold. A sale shows as a `Swapped` plus the vault's
`SlotSold` (or `SlotBurned`, `SlotBought`) in the same transaction. Any cranker may send these
steps, for a bounty of at most 1% of the step.

## Transfers between wallets

A transfer of a hooked token must carry the hook's accounts, resolved for that transfer:

```ts
import { fetchTokenHook, holdingAddress, token } from '@bordrless/sdk';

const source = holdingAddress(mint, from), destination = holdingAddress(mint, to);
const hook = await fetchTokenHook(connection, { mint, source, destination, authority: from, sourceOwner: from, destinationOwner: to });
const ixs = [token.createHolding(from, mint, to), token.transfer(from, source, destination, mint, amount, hook)];
```

The receiver gets `amount` less whatever the hook cut. The `Transferred` event lists each cut.
Kit tokens enforce their locks and max wallet on transfers too.
