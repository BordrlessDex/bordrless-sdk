/**
 * The strategy interface (phase 3a, `crates/bordrless-strategy`): the two questions the companion
 * asks a strategy program by CPI, every account read-only and no signer, and their Borsh encodings.
 *
 * - `plan` (`PLAN_DISCRIMINATOR ‖ PlanArgs`) answers `PlanDecision { budget }`: what the period that
 *   just ended pays in all, at most `budgetMax`;
 * - `entitle` (`ENTITLE_DISCRIMINATOR ‖ EntitleArgs`) answers `Entitlement { amount }`: what one
 *   holding gets, at most `maxAmount` (the companion never clamps: an answer over it pays nothing).
 *
 * The answer is the strategy's own return data, exactly 8 bytes (one u64). Studio's simulator and
 * the keeper build the same arguments the companion builds (`planArgsOf`, `entitleArgsOf`).
 */
import { PublicKey } from '@solana/web3.js';
import { decodeTicketSlots, rangeIn, roundEnd, roundStart, ticketEligible, type HoldingView } from './game.ts';
import { holdingAddress } from './addresses.ts';

export const PLAN_DISCRIMINATOR = Buffer.from([0x0f, 0xb9, 0x2d, 0x20, 0xa3, 0x06, 0xd8, 0x4d]);
export const ENTITLE_DISCRIMINATOR = Buffer.from([0x1f, 0xc5, 0x5b, 0x2d, 0xda, 0x60, 0x0d, 0xaf]);
export const STRATEGY_ARGS_VERSION = 1;
/** `plan` gets `[game, companion, hookState, launch, pool]` before its extras; `entitle` `[game, companion, hookState, launch, holding]`. */
export const STRATEGY_PREFIX = 5;
/** A strategy's registry may name at most 2 extras, each owned by it, resolved against `[mint, game]` once, when its game is made. */
export const STRATEGY_REGISTRY_PREFIX = ['mint', 'game'] as const;

export interface PlanArgs {
  mint: PublicKey;
  period: number;
  periodStart: number;
  periodEnd: number;
  total: bigint;
  pot: bigint;
  budgetMax: bigint;
  periodsPlanned: number;
  paidTotal: bigint;
  now: number;
}

export interface EntitleArgs {
  mint: PublicKey;
  period: number;
  owner: PublicKey;
  balance: bigint;
  weight: bigint;
  since: number;
  total: bigint;
  budget: bigint;
  paid: bigint;
  maxAmount: bigint;
  now: number;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

/** `PlanArgs`'s Borsh bytes (without the discriminator). */
export function encodePlanArgs(p: PlanArgs): Buffer {
  return Buffer.concat([Buffer.from([STRATEGY_ARGS_VERSION]), p.mint.toBuffer(), u32(p.period), i64(p.periodStart), i64(p.periodEnd), u64(p.total), u64(p.pot), u64(p.budgetMax), u32(p.periodsPlanned), u64(p.paidTotal), i64(p.now)]);
}

/** `EntitleArgs`'s Borsh bytes (without the discriminator). */
export function encodeEntitleArgs(e: EntitleArgs): Buffer {
  return Buffer.concat([Buffer.from([STRATEGY_ARGS_VERSION]), e.mint.toBuffer(), u32(e.period), e.owner.toBuffer(), u64(e.balance), u64(e.weight), i64(e.since), u64(e.total), u64(e.budget), u64(e.paid), u64(e.maxAmount), i64(e.now)]);
}

/** A `plan` instruction's data, as the companion sends it. */
export const planData = (p: PlanArgs): Buffer => Buffer.concat([PLAN_DISCRIMINATOR, encodePlanArgs(p)]);
/** An `entitle` instruction's data, as the companion sends it. */
export const entitleData = (e: EntitleArgs): Buffer => Buffer.concat([ENTITLE_DISCRIMINATOR, encodeEntitleArgs(e)]);

/** A strategy's answer (its return data): the u64, or null when it is not exactly 8 bytes. */
export function decodeAnswer(data: Uint8Array): bigint | null {
  return data.length === 8 ? Buffer.from(data).readBigUInt64LE(0) : null;
}
/** An answer's bytes (`PlanDecision { budget }`, `Entitlement { amount }`). */
export const encodeAnswer = (v: bigint): Buffer => u64(v);

const bps = (v: bigint, part: number): bigint => (v * BigInt(part)) / 10_000n;

/** The `PlanArgs` the companion builds for `period` (`plan_period`): `budgetMax` is the strategy's `budgetBps` of the pot (already trimmed to its cap). */
export function planArgsOf(o: { mint: PublicKey; period: number; roundSecs: number; total: bigint; pot: bigint; budgetBps: number; periodsPlanned: number; paidTotal: bigint; now: number }): PlanArgs {
  return { mint: o.mint, period: o.period, periodStart: roundStart(o.period, o.roundSecs), periodEnd: roundEnd(o.period, o.roundSecs), total: o.total, pot: o.pot, budgetMax: bps(o.pot, o.budgetBps), periodsPlanned: o.periodsPlanned, paidTotal: o.paidTotal, now: o.now };
}

/** The `EntitleArgs` the companion builds for one candidate (`pay_strategy`): `maxAmount` is `maxShareBps` of the budget, and no more than what is left of it. */
export function entitleArgsOf(o: { mint: PublicKey; period: number; owner: PublicKey; balance: bigint; weight: bigint; since: number; total: bigint; budget: bigint; paid: bigint; maxShareBps: number; now: number }): EntitleArgs {
  const cap = bps(o.budget, o.maxShareBps);
  const left = o.budget > o.paid ? o.budget - o.paid : 0n;
  return { mint: o.mint, period: o.period, owner: o.owner, balance: o.balance, weight: o.weight, since: o.since, total: o.total, budget: o.budget, paid: o.paid, maxAmount: cap < left ? cap : left, now: o.now };
}

/** `amount * part / whole`, rounded down (0 for a whole of 0): the pro-rata starter's entitlement before it keeps within `maxAmount`. */
export const proRata = (amount: bigint, part: bigint, whole: bigint): bigint => (whole === 0n ? 0n : (amount * part) / whole);

/** A DEX pool's reserves from its account data (`bordrless_strategy::pool_reserves`): null for data too short or a bad option tag. */
export function poolReserves(data: Buffer): { baseMint: PublicKey; quoteMint: PublicKey; lpFeeBps: number; baseReserve: bigint; quoteReserve: bigint; virtualBase: bigint; virtualQuote: bigint } | null {
  if (data.length < 172) return null;
  let at = 171;
  if (data[at] === 0) at += 1;
  else if (data[at] === 1) at += 33;
  else return null;
  if (data.length < at + 6 + 32) return null;
  const lpFeeBps = data.readUInt16LE(at + 2);
  at += 6;
  return {
    baseMint: new PublicKey(data.subarray(11, 43)),
    quoteMint: new PublicKey(data.subarray(43, 75)),
    lpFeeBps,
    baseReserve: data.readBigUInt64LE(at),
    quoteReserve: data.readBigUInt64LE(at + 8),
    virtualBase: data.readBigUInt64LE(at + 16),
    virtualQuote: data.readBigUInt64LE(at + 24),
  };
}

/**
 * The holdings `pay_strategy` would take for `period`: the mint's holding at its owner's address, an
 * eligible wallet (none of `excluded`: the launch, its pool, the creator address, the companion, the
 * game, the terms, the oracle payer, the strategy, the hook), its weight for the period (its ticket
 * range for that round) at least `minWeight` and at most its balance. The strategy decides each
 * amount; the companion refuses the rest on chain.
 */
export function strategyCandidates(holdings: readonly HoldingView[], mint: PublicKey, period: number, minWeight: bigint, excluded: readonly PublicKey[]): HoldingView[] {
  return holdings.filter((h) => {
    if (!h.mint.equals(mint) || !h.address.equals(holdingAddress(mint, h.owner)) || !ticketEligible(h.owner, excluded)) return false;
    const range = rangeIn(decodeTicketSlots(h.hookData), period);
    return range !== null && range.weight >= (minWeight < 1n ? 1n : minWeight) && range.weight <= h.amount;
  });
}
