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
| **A custom hook** | any other `hookProgram` | Anything: refuse transfers (a honeypot), take cuts | **"Custom hook, unverified"** and the program |

For any hooked token, also check `mint.hookAuthority`. **`null` means the hook can never be
changed.** Otherwise someone can swap the hook later. Launchpad tokens always have it `null`.
Whether the hook program itself is upgradeable:
`fetchProgramUpgradeInfo(connection, mint.hookProgram)`.

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
`rewardsClaimable(kitRewardsOf(kit), vaultAmount, now, holding.amount, kitHookDataOf(holding), kitExcludes(kit, owner))?.payable`
from `@bordrless/shared` and the SDK (`vaultAmount` is the balance of the reward vault
`launch.holderVault`). Claim with `kit.claim(owner, mint, kit.rewardMint)`, then
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
