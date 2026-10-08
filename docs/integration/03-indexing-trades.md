# 3. Indexing trades

Every Bordrless program emits **Anchor event CPIs**: each event is an inner instruction from the
program to its own event authority (`["__event_authority"]`), its data the 8-byte event tag
`e445a52e51cb9a1d`, then the event's discriminator and Borsh body. They're in the transaction's
`meta.innerInstructions`, not its logs, so they survive log truncation.

## Decoding events from a transaction

From [`recent-trades.ts`](../../examples/recent-trades.ts):

```ts
import bs58 from 'bs58';
import { eventsOf, typedEvent, type RawInnerInstruction } from '@bordrless/sdk';

const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });

// Inner instructions index into the static keys, then the lookup tables' writable, then read-only addresses.
const loaded = tx.meta.loadedAddresses;
const keys = [...tx.transaction.message.staticAccountKeys.map(String), ...(loaded?.writable ?? []).map(String), ...(loaded?.readonly ?? []).map(String)];
const inner = tx.meta.innerInstructions.flatMap((g) => g.instructions as RawInnerInstruction[]);

for (const event of eventsOf(keys, inner, (data) => Buffer.from(bs58.decode(data)))) {
  const typed = typedEvent(event);         // null for events without a typed view
  if (typed?.kind === 'swap.Swapped') { /* a trade */ }
}
```

`eventsOf` only reads event CPIs: inner instructions to a Bordrless program whose only account is
that program's event authority and whose data starts with the event tag. Only the program can sign
as its own event authority, so an instruction that fakes an event fails on chain. **Skip failed
transactions** (`tx.meta.err`): their events never happened. Most Bordrless transactions use the
protocol lookup table, so **always include the loaded addresses** in the key list.

## `Swapped`: a trade

| Field | Meaning |
| --- | --- |
| `pool`, `trader`, `recipient` | The pool; who signed; whose holding received the output |
| `direction` | 1 buy (quote in, token out), 0 sell |
| `amountIn` | What left the trader's wallet, in the input token |
| `burnIn`, `cutsIn`, `receivedIn` | From the input: burned, taken by hooks for someone, and what reached the pool |
| `lpFee` | LP fee, in the input token |
| `protocolFee` | Bordrless's take, **always in the quote (SOL)** |
| `amountOut` | What the curve gave, in the output token |
| `burnOut`, `cutsOut`, `deliveredOut` | From the output: burned, taken by hooks, and what reached the recipient |
| `deltasIn`, `deltasOut` | Each hook cut: the holding it went to and the amount |
| `baseReserve`, `quoteReserve`, `virtualBase`, `virtualQuote` | The pool **after** the trade |
| `swapCount`, `slot`, `ts` | The pool's trade counter, the slot and the unix time |

**Units follow the side.** Input-side fields (`amountIn`, `burnIn`, `cutsIn`, `receivedIn`, `lpFee`)
are in the input token, SOL on a buy and the token on a sell. Output-side fields are in the other
token. `protocolFee` is always SOL. Don't add `cutsIn` to `cutsOut`.

What a trade is, as a user saw it:

```ts
const buy = typed.direction === 1;
const solAmount = buy ? typed.amountIn : typed.deliveredOut;    // SOL spent, or SOL received
const tokenAmount = buy ? typed.deliveredOut : typed.amountIn;  // tokens received, or tokens sold
const priceAfter =
  Number(typed.quoteReserve + typed.virtualQuote) / Number(typed.baseReserve + typed.virtualBase) *
  10 ** (tokenDecimals - 9);                                     // SOL per whole token
```

Real output from mainnet, a buy and a Half-Life sell:

```
BUY   1.7 SOL  22537607.831353 hLife  price after 7.6251e-8 SOL  lp 0.005049 SOL, protocol 0.00425 SOL, hook cuts 0.017 SOL in + 0 hLife out
SELL  0.4975865 SOL  9228637.680673 hLife  … hook cuts 1830957.526058 hLife in …
```

The buy's `cutsIn` is the 1% creator fee, and Bordrless's `protocolFee` is 25% of it. The sell's
`cutsIn` is Half-Life's exit fee: the seller had held for minutes, so about 20% of the tokens they
sold went to the furnace. Use `deliveredOut` and `amountIn` for what the user actually got and
gave. The pool price moved by `receivedIn` after fees, not by `amountIn`.

**Volume:** sum `amountIn` on buys and `deliveredOut` on sells for user-facing SOL volume, or use
`Pool.quoteVolume` for the pool's own total. **Candles:** bucket `priceAfter` by `ts`. The first
trade's open is the price before it, from the previous event's reserves or the launch's opening
reserves.

## Which transactions to read

A pool's address is in every swap on it, so `getSignaturesForAddress(pool)` lists a token's trades.
For the whole market, stream the DEX program (`GyzKSnnE…7hk`) with a websocket `logsSubscribe` /
`onLogs` mentioning it, or a Geyser transaction filter on it, and decode each transaction as above.
Graduation, claims and launches go through the launchpad and the kit. Subscribe to the programs
whose events you need.

## New launches

`launch.LaunchCreated`, from the launchpad's transactions, carries everything a new token row needs:
`mint`, `pool`, `creator`, `name`, `symbol`, `uri`, `supply`, `decimals`, the curve
(`virtualQuote`, `virtualBase`, `graduationQuote`, `curveTokens`, `reserveTokens`), the fees, the
`rules` with their `modules`, `config` and `customHook`.

## Every event

| Program | Events |
| --- | --- |
| token | `MintCreated`, `Minted`, `Burned`, `Transferred` (with each hook cut), `HoldingCreated`, `HoldingClosed`, `HookDataWritten`, `HookSet`, `AuthoritySet`, `DelegateSet`, `FrozenSet`, `MetadataUpdated` |
| swap (DEX) | `PoolCreated`, `Swapped`, `LiquidityAdded`, `LiquidityRemoved`, `CurveFinalized`, `ProtocolFeesCollected`, `ConfigSet` |
| launch | `LaunchCreated`, `Graduated`, `CreatorFeesClaimed`, `LaunchConfigCreated`, `ConfigSet` |
| kit | `KitInstalled`, `KitGraduated`, `RewardsClaimed`, `RewardsShared` |
| bridge | `WrapperRegistered`, `Wrapped`, `Unwrapped`, `ConfigSet` |

`typedEvent` types the ones an indexer needs (`token.Transferred`, `token.HookDataWritten`,
`swap.Swapped`, `swap.ProtocolFeesCollected`, `launch.LaunchCreated`, `launch.LaunchConfigCreated`,
and the kit's four). Every other event is still in `eventsOf`'s output as `{ program, name, data }`,
with keys as base58 strings and integers as decimal strings.

Half-Life's `Stoked` (the furnace burned) is a plain log event (`Program data:` in the logs), not
an event CPI. Watch the mint's `Burned` event from the token program instead, or decode the log
with the IDL.

## Graduation

A token graduated when `launch.Graduated` is emitted, or `Launch.status` reads 1. The same pool
keeps trading. Its virtual reserves drop to zero at that point and the reserve's top-up is added,
so the price is continuous across it.
