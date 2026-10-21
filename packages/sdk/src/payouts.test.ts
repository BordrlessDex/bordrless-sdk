/**
 * §7.5 (docs/token-quotes.md §7.5.5): holder rewards in the quote token and the SOL switch. Every builder against the regenerated IDLs
 * (the accounts' names, order and marks, the event accounts, the discriminator), the `TokenPayouts` bytes, the leg trade's vault and the
 * kind-1 slice, the hand-read accounts (`KitRounds`, `PayeesLegs`) laid out from §7.5.5's offsets, `QuoteReference` through the IDL's
 * layout, the eleven events typed, and the venue readers on pools read from mainnet on 21 Oct 2026 (bordrless-programs'
 * `programs/tests/fixtures/venues`, copied into `vectors/venues`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type AccountInfo, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import * as a from './addresses.ts';
import { CODERS, IDL } from './coders.ts';
import { decodeEventPayload } from './events.ts';
import { decodeKitConfig, decodeLaunch } from './accounts.ts';
import { companion, decodeCompanionLegs, COMPANION_LEGS_LEN, payeesLegsAddress } from './companion.ts';
import { kitVaultAddress, legsAddress, legsHookSlice, NO_TOKEN_LAUNCH_RULES, tokenLaunch, type LegKeys } from './legs.ts';
import {
  HOLDER_ROUND_SECS,
  KIT_ROUNDS_DISCRIMINATOR,
  KIT_ROUNDS_LEN,
  PAYEES_LEGS_DISCRIMINATOR,
  PAYEES_LEGS_LEN,
  PAYOUT_SOL,
  QUOTE_REFERENCE_LEN,
  REWARD_KIND,
  USDC_MINT,
  VENUE,
  ammV4Accounts,
  clmmTickAccounts,
  cpmmAccounts,
  currentRound,
  decodeKitRounds,
  decodePayeesLegs,
  decodeQuoteReference,
  kitPayouts,
  kitRoundsAddress,
  legSliceFor,
  legSwapFor,
  marketOf,
  quoteReference,
  quoteReferenceAddress,
  rewardKindOf,
  roundDataOf,
  roundLeast,
  solSwitch,
  swapMinOut,
  swapToSolRest,
  swapWindowCap,
  tokenPayoutsProblem,
  tokenRewardsHookSlice,
  typedPayoutEvent,
  valueAtQ64,
  venueReads,
  viaUsdcAccounts,
} from './payouts.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } } | { option: IdlType } | { vec: IdlType };
/** An account of the IDL's type laid out by the IDL's own layout: every field zero, the given fields laid over the top level. */
function zeroAccount(program: 'launch' | 'kit' | 'companion', type: string, over: Record<string, unknown> = {}): Buffer {
  const types = (IDL[program] as unknown as { types: { name: string; type: { kind: string; fields?: { name: string; type: IdlType }[]; variants?: { name: string }[] } }[] }).types;
  const camel = (x: string) => x.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const zero = (t: IdlType): unknown => {
    if (typeof t === 'string') return t === 'pubkey' ? PublicKey.default : /^[ui](64|128)$/.test(t) ? new BN(0) : t === 'bool' ? false : t === 'string' ? '' : 0;
    if ('array' in t) return Array.from({ length: t.array[1] }, () => zero(t.array[0]));
    if ('option' in t) return null;
    if ('vec' in t) return [];
    const def = types.find((x) => x.name === t.defined.name)!;
    if (def.type.kind === 'enum') return { [camel(def.type.variants![0]!.name).replace(/^./, (c) => c.toLowerCase())]: {} };
    return Object.fromEntries(def.type.fields!.map((f) => [camel(f.name), zero(f.type)]));
  };
  const value = { ...(zero({ defined: { name: type } }) as Record<string, unknown>), ...over };
  const name = type.charAt(0).toLowerCase() + type.slice(1);
  const coder = CODERS[program].accounts as unknown as { size: (n: string) => number; accountLayouts: Map<string, { discriminator: number[]; layout: { encode: (v: unknown, b: Buffer) => number } }> };
  const entry = coder.accountLayouts.get(name)!;
  const d = Buffer.alloc(coder.size(name));
  Buffer.from(entry.discriminator).copy(d, 0);
  entry.layout.encode(value, d.subarray(8));
  return d;
}
type IdlProgram = 'launch' | 'kit' | 'companion';
interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}
const PROGRAM_OF: Record<IdlProgram, PublicKey> = { launch: a.LAUNCH_PROGRAM, kit: a.KIT_PROGRAM, companion: a.COMPANION_PROGRAM };
const instructionOf = (program: IdlProgram, name: string) => (IDL[program] as unknown as { instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[] }).instructions.find((i) => i.name === name)!;

/** The builder's named accounts against the IDL's (names, order, marks, fixed addresses, the event accounts last, the discriminator); what follows them. */
function heldToIdl(ix: TransactionInstruction, program: IdlProgram, name: string): TransactionInstruction['keys'] {
  const idl = instructionOf(program, name);
  expect(ix.programId.equals(PROGRAM_OF[program]), name).toBe(true);
  expect(ix.keys.length).toBeGreaterThanOrEqual(idl.accounts.length);
  idl.accounts.forEach((acc, i) => {
    const meta = ix.keys[i]!;
    expect([acc.name, meta.isWritable, meta.isSigner], `${name} #${i}`).toEqual([acc.name, acc.writable === true, acc.signer === true]);
    if (acc.address) expect(meta.pubkey.toBase58(), `${name} ${acc.name}`).toBe(acc.address);
  });
  expect(ix.keys[idl.accounts.length - 2]!.pubkey.equals(a.eventAuthority(ix.programId))).toBe(true);
  expect(ix.keys[idl.accounts.length - 1]!.pubkey.equals(ix.programId)).toBe(true);
  expect([...ix.data.subarray(0, 8)], name).toEqual(idl.discriminator);
  return ix.keys.slice(idl.accounts.length);
}
const keysOf = (metas: TransactionInstruction['keys']): string[] => metas.map((m) => m.pubkey.toBase58());
/** A nonce AMM v4's authority derives off the curve with (`["amm authority", [nonce]]`; mainnet pools store their own). */
const NONCE = [255, 254, 253, 252].find((n) => { try { PublicKey.createProgramAddressSync([Buffer.from('amm authority'), Buffer.from([n])], new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')); return true; } catch { return false; } })!;
const leg = (over: Partial<LegKeys> = {}): LegKeys => ({ mint: k(), quoteMint: k(), quoteProgram: a.SPL_TOKEN_PROGRAM, lpFeeBps: 30, ...over });

describe('TokenPayouts and the reward kind (§7.5.5)', () => {
  const args = { name: 'Paid', symbol: 'PAID', uri: 'ipfs://p', creatorFeeBps: 100, virtualQuotes: [1_000n] };
  it('writes the payouts only when set, after the rules (22 zero bytes when there are none)', () => {
    const mint = k();
    const plain = tokenLaunch.createTokenLaunch(k(), mint, k(), args, [k()]);
    const ruled = tokenLaunch.createTokenLaunch(k(), mint, k(), { ...args, rules: { ...NO_TOKEN_LAUNCH_RULES, holderFeeBuyBps: 100, holderFeeSellBps: 100 } }, [k()]);
    const paid = tokenLaunch.createTokenLaunch(k(), mint, k(), { ...args, payouts: { flags: PAYOUT_SOL, holderRoundSecs: 0 } }, [k()]);
    const zero = tokenLaunch.createTokenLaunch(k(), mint, k(), { ...args, payouts: { flags: 0, holderRoundSecs: 0 } }, [k()]);
    expect(zero.data).toEqual(plain.data);
    expect(ruled.data.length).toBe(plain.data.length + 22);
    expect(paid.data.length).toBe(plain.data.length + 22 + 5);
    expect([...paid.data.subarray(plain.data.length, plain.data.length + 22)]).toEqual(Array(22).fill(0));
    expect([...paid.data.subarray(-5)]).toEqual([1, 0, 0, 0, 0]);
    const rounds = tokenLaunch.createTokenLaunch(k(), mint, k(), { ...args, payouts: { flags: 0, holderRoundSecs: 1_800 } }, [k()]);
    expect(Buffer.from(rounds.data.subarray(-4)).readUInt32LE(0)).toBe(1_800);
    // The companion's launch_token: the rules always, as §7.4 sent them; the payouts when set.
    const inner = tokenLaunch.createTokenLaunchWith(a.companionCreatorAddress(mint), mint, k(), args, [k()], null, null);
    const lt = companion.launchToken(k(), mint, inner, args);
    const ltPaid = companion.launchToken(k(), mint, inner, { ...args, payouts: { flags: PAYOUT_SOL, holderRoundSecs: 0 } });
    expect(ltPaid.data.length).toBe(lt.data.length + 5);
  });

  it('refuses another flag or a round out of bounds', () => {
    expect(tokenPayoutsProblem({ flags: 1, holderRoundSecs: 0 })).toBeNull();
    expect(tokenPayoutsProblem({ flags: 0, holderRoundSecs: HOLDER_ROUND_SECS.min })).toBeNull();
    expect(tokenPayoutsProblem({ flags: 2, holderRoundSecs: 0 })).toMatch(/bit 0/);
    expect(tokenPayoutsProblem({ flags: 0, holderRoundSecs: 599 })).toMatch(/600/);
    expect(tokenPayoutsProblem({ flags: 0, holderRoundSecs: 86_401 })).toMatch(/600/);
  });

  it('picks the kind as the launchpad does: none without a holder fee, SOL with the switch, the token on one leg, rounds on several', () => {
    expect(rewardKindOf({ tokenQuoted: true, modules: 2, payouts: 1 }, 1)).toBe(REWARD_KIND.none);
    expect(rewardKindOf({ tokenQuoted: false, modules: 1, payouts: 0 }, 1)).toBe(REWARD_KIND.none);
    expect(rewardKindOf({ tokenQuoted: true, modules: 1, payouts: 1 }, 3)).toBe(REWARD_KIND.sol);
    expect(rewardKindOf({ tokenQuoted: true, modules: 1, payouts: 0 }, 1)).toBe(REWARD_KIND.token);
    expect(rewardKindOf({ tokenQuoted: true, modules: 3, payouts: 0 }, 2)).toBe(REWARD_KIND.rounds);
  });

});

describe('a leg trade with holder rewards', () => {
  const rules = { ...NO_TOKEN_LAUNCH_RULES, holderFeeBuyBps: 100, holderFeeSellBps: 100 };
  it('carries the kit vault after the leg’s extras (26 accounts), the vault in place of the kit’s id on one leg', () => {
    const keys = leg();
    const one = { tokenQuoted: true, modules: 1, payouts: 0, rules };
    const swap = legSwapFor(one, 1, keys, k(), k(), 1, 1_000n, 1n);
    expect(swap.keys).toHaveLength(26);
    expect(swap.keys.at(-1)).toEqual({ pubkey: kitVaultAddress(keys), isSigner: false, isWritable: true });
    expect(keysOf(legSliceFor(one, 1, keys))).toEqual(keysOf(tokenRewardsHookSlice(keys.mint, kitVaultAddress(keys))));
    expect(keysOf(legSliceFor(one, 1, keys))[3]).toBe(kitVaultAddress(keys).toBase58());
    // Rounds and SOL: the kit's id as before.
    expect(keysOf(legSliceFor(one, 2, keys))).toEqual(keysOf(legsHookSlice(keys.mint)));
    expect(keysOf(legSliceFor({ ...one, payouts: 1 }, 1, keys))).toEqual(keysOf(legsHookSlice(keys.mint)));
    // Without holder rewards: exactly the phase-1 swap.
    const capped = { tokenQuoted: true, modules: 2, payouts: 0, rules: { ...NO_TOKEN_LAUNCH_RULES, maxWalletBps: 200 } };
    const trader = k();
    expect(keysOf(legSwapFor(capped, 1, keys, trader, trader, 0, 5n, 1n).keys)).toEqual(keysOf(tokenLaunch.legSwap(keys, trader, trader, 0, 5n, 1n, capped.rules).keys));
  });

  it('open_leg takes the vault as a fourth kit account with holder rewards', () => {
    const keys = leg();
    const open = tokenLaunch.openLeg(k(), k(), keys, 0, 1 | 2);
    const capped = tokenLaunch.openLeg(k(), k(), keys, 0, 2);
    expect(open.keys.length).toBe(capped.keys.length + 1);
    expect(open.keys.at(-1)).toEqual({ pubkey: kitVaultAddress(keys), isSigner: false, isWritable: true });
    expect(kitVaultAddress(keys).equals(a.associatedTokenAddress(a.kitConfigAddress(keys.mint), keys.quoteMint, keys.quoteProgram))).toBe(true);
  });
});

describe('the kit’s builders (against the IDL)', () => {
  const [mint, owner, payer, quote, quote2] = [k(), k(), k(), k(), k()];
  it('claim_token, claim_token_for and share_token', () => {
    expect(heldToIdl(kitPayouts.claimToken(owner, mint, quote, a.SPL_TOKEN_PROGRAM), 'kit', 'claim_token')).toEqual([]);
    const claim = kitPayouts.claimToken(owner, mint, quote, a.SPL_TOKEN_2022_PROGRAM);
    expect(claim.keys[5]!.pubkey.equals(a.associatedTokenAddress(a.kitConfigAddress(mint), quote, a.SPL_TOKEN_2022_PROGRAM))).toBe(true);
    expect(claim.keys[6]!.pubkey.equals(a.associatedTokenAddress(owner, quote, a.SPL_TOKEN_2022_PROGRAM))).toBe(true);
    expect(claim.keys[7]!.pubkey.equals(legsAddress(mint))).toBe(true);
    const dest = k();
    const pushed = kitPayouts.claimTokenFor(payer, owner, mint, quote, a.SPL_TOKEN_PROGRAM, dest);
    expect(heldToIdl(pushed, 'kit', 'claim_token_for')).toEqual([]);
    expect(pushed.keys[7]!.pubkey.equals(dest)).toBe(true);
    const share = kitPayouts.shareToken(payer, mint, 2, quote, a.SPL_TOKEN_PROGRAM, dest, 77n);
    expect(heldToIdl(share, 'kit', 'share_token')).toEqual([]);
    expect(CODERS.kit.instruction.decode(share.data)).toMatchObject({ name: 'shareToken', data: { index: 2 } });
  });

  it('start_round and pay_round with every leg’s vault, token accounts and programs', () => {
    const legs = [{ quoteMint: quote, quoteProgram: a.SPL_TOKEN_PROGRAM }, { quoteMint: quote2, quoteProgram: a.SPL_TOKEN_2022_PROGRAM }];
    const start = heldToIdl(kitPayouts.startRound(payer, mint, legs), 'kit', 'start_round');
    expect(keysOf(start)).toEqual(legs.map((l) => a.associatedTokenAddress(a.kitConfigAddress(mint), l.quoteMint, l.quoteProgram).toBase58()));
    const pay = kitPayouts.payRound(payer, owner, mint, legs, true);
    const rest = heldToIdl(pay, 'kit', 'pay_round');
    expect(keysOf(rest)).toEqual([
      a.associatedTokenAddress(a.kitConfigAddress(mint), quote, a.SPL_TOKEN_PROGRAM).toBase58(), quote.toBase58(), a.associatedTokenAddress(owner, quote, a.SPL_TOKEN_PROGRAM).toBase58(),
      a.associatedTokenAddress(a.kitConfigAddress(mint), quote2, a.SPL_TOKEN_2022_PROGRAM).toBase58(), quote2.toBase58(), a.associatedTokenAddress(owner, quote2, a.SPL_TOKEN_2022_PROGRAM).toBase58(),
      a.SPL_TOKEN_PROGRAM.toBase58(), a.SPL_TOKEN_2022_PROGRAM.toBase58(), a.ATA_PROGRAM.toBase58(),
    ]);
    expect(pay.keys[2]!.pubkey.equals(kitRoundsAddress(mint))).toBe(true);
    expect(heldToIdl(kitPayouts.payRound(payer, owner, mint, legs.slice(0, 1), false), 'kit', 'pay_round')).toHaveLength(4);
  });

  it('swap_rewards_to_sol takes swap_to_sol’s accounts from the launch on, the kit config the seller', () => {
    const keys = leg();
    const venue = ammV4Accounts(k(), NONCE, k(), k());
    const rest = swapToSolRest(a.kitConfigAddress(keys.mint), keys.mint, keys.quoteMint, keys.quoteProgram, venue);
    const ix = kitPayouts.swapRewardsToSol(payer, keys.mint, 0, keys.quoteMint, keys.quoteProgram, 0n, rest);
    expect(keysOf(heldToIdl(ix, 'kit', 'swap_rewards_to_sol'))).toEqual(keysOf(rest));
    expect(rest[2]!.pubkey.equals(a.associatedTokenAddress(a.kitConfigAddress(keys.mint), a.NATIVE_MINT_KEY, a.SPL_TOKEN_PROGRAM))).toBe(true);
  });
});

describe('the launchpad’s builders (against the IDL)', () => {
  const keys = leg();
  it('register_quote_pool with the venue, USDC’s and the replaced pool’s accounts; pause_quote_reference', () => {
    const venue = cpmmAccounts(k(), k(), k(), k(), k());
    expect(keysOf(heldToIdl(quoteReference.register(k(), keys.quoteMint, venue), 'launch', 'register_quote_pool'))).toEqual(keysOf(venue));
    const usdc = ammV4Accounts(k(), NONCE, k(), k());
    const old = ammV4Accounts(k(), NONCE, k(), k());
    const all = heldToIdl(quoteReference.register(k(), keys.quoteMint, venue, usdc, old), 'launch', 'register_quote_pool');
    expect(keysOf(all)).toEqual([...keysOf(venue), quoteReferenceAddress(USDC_MINT).toBase58(), USDC_MINT.toBase58(), ...keysOf(usdc), ...keysOf(old)]);
    expect(heldToIdl(quoteReference.pause(k(), keys.quoteMint, true), 'launch', 'pause_quote_reference')).toEqual([]);
    expect(quoteReferenceAddress(keys.quoteMint).equals(PublicKey.findProgramAddressSync([Buffer.from('quote-ref'), keys.quoteMint.toBuffer()], a.LAUNCH_PROGRAM)[0])).toBe(true);
  });

  it('swap_to_sol and swap_creator_fees, the venue after the named accounts', () => {
    const venue = ammV4Accounts(k(), NONCE, k(), k());
    const seller = k();
    const ix = solSwitch.swapToSol(k(), seller, keys, k(), 5n, venue);
    expect(keysOf(heldToIdl(ix, 'launch', 'swap_to_sol'))).toEqual(keysOf(venue));
    // The rest builder is swap_to_sol's accounts from the launch on, less the Legs, the quote mint and the source.
    const rest = swapToSolRest(seller, keys.mint, keys.quoteMint, keys.quoteProgram, venue);
    expect(keysOf([ix.keys[2]!, ...ix.keys.slice(6)])).toEqual(keysOf(rest));
    const fees = solSwitch.swapCreatorFees(k(), keys, 1, 9n, venue);
    expect(keysOf(heldToIdl(fees, 'launch', 'swap_creator_fees'))).toEqual(keysOf(venue));
    expect(fees.keys[6]!.pubkey.equals(a.associatedTokenAddress(a.launchAddress(keys.mint), a.NATIVE_MINT_KEY, a.SPL_TOKEN_PROGRAM))).toBe(true);
  });

  it('the venue accounts: AMM v4’s authority by its nonce, USDC’s chain', () => {
    const [pool, coin, pc] = [k(), k(), k()];
    const amm = ammV4Accounts(pool, NONCE, coin, pc);
    expect(amm[2]!.pubkey.equals(PublicKey.createProgramAddressSync([Buffer.from('amm authority'), Buffer.from([NONCE])], new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')))).toBe(true);
    const seller = k();
    const via = viaUsdcAccounts(seller, amm, amm);
    expect(keysOf(via.slice(0, 3))).toEqual([USDC_MINT.toBase58(), a.associatedTokenAddress(seller, USDC_MINT, a.SPL_TOKEN_PROGRAM).toBase58(), quoteReferenceAddress(USDC_MINT).toBase58()]);
    expect(via).toHaveLength(13);
  });
});

describe('the companion’s builders (against the IDL)', () => {
  const keys = leg();
  it('share_leg: the kit’s share_token for the creator address as remaining', () => {
    const ix = companion.shareLeg(k(), keys, 1, false);
    const rest = heldToIdl(ix, 'companion', 'share_leg');
    const creator = a.companionCreatorAddress(keys.mint);
    expect(rest[0]).toEqual({ pubkey: creator, isSigner: false, isWritable: false });
    expect(keysOf(rest).slice(1, 7)).toEqual([a.kitConfigAddress(keys.mint), legsAddress(keys.mint), keys.quoteMint, a.associatedTokenAddress(creator, keys.quoteMint, keys.quoteProgram), kitVaultAddress(keys), keys.quoteProgram].map(String));
    expect(rest.at(-1)!.pubkey.equals(a.KIT_PROGRAM)).toBe(true);
    expect(companion.shareLeg(k(), keys, 1, true).keys.length).toBe(ix.keys.length + 1);
  });

  it('swap_bucket_to_sol: the Legs, the quote mint, the creator address’s account, then swap_to_sol’s rest', () => {
    const venue = cpmmAccounts(k(), k(), k(), k(), k());
    const ix = companion.swapBucketToSol(k(), keys, 0, 1, venue);
    const rest = heldToIdl(ix, 'companion', 'swap_bucket_to_sol');
    const creator = a.companionCreatorAddress(keys.mint);
    const sale = swapToSolRest(creator, keys.mint, keys.quoteMint, keys.quoteProgram, venue);
    expect(keysOf(rest)).toEqual([legsAddress(keys.mint).toBase58(), keys.quoteMint.toBase58(), a.associatedTokenAddress(creator, keys.quoteMint, keys.quoteProgram).toBase58(), ...keysOf(sale.slice(1))]);
    expect(CODERS.companion.instruction.decode(ix.data)).toMatchObject({ name: 'swapBucketToSol', data: { index: 0, part: 1 } });
  });

  it('withdraw_leg with payees, and launch_token with PayeesLegs', () => {
    const [w1, w2] = [k(), k()];
    const plain = companion.withdrawLeg(k(), k(), keys, 0);
    const paid = companion.withdrawLegWithPayees(k(), k(), keys, 0, [w1, w2]);
    heldToIdl(paid, 'companion', 'withdraw_leg');
    expect(keysOf(paid.keys.slice(plain.keys.length))).toEqual([a.payeesAddress(keys.mint), payeesLegsAddress(keys.mint), w1, a.associatedTokenAddress(w1, keys.quoteMint, keys.quoteProgram), w2, a.associatedTokenAddress(w2, keys.quoteMint, keys.quoteProgram)].map(String));
    const args = { name: 'P', symbol: 'P', uri: 'u', creatorFeeBps: 100, virtualQuotes: [1n] };
    const inner = tokenLaunch.createTokenLaunch(a.companionCreatorAddress(keys.mint), keys.mint, k(), args, [keys.quoteMint]);
    const lt = companion.launchTokenWithPayees(k(), keys.mint, inner, args);
    expect(lt.keys.at(-1)).toEqual({ pubkey: payeesLegsAddress(keys.mint), isSigner: false, isWritable: true });
  });
});

describe('accounts read by hand and through the IDL', () => {
  it('KitRounds (191 B) from §7.5.5’s offsets, and a holding’s round bytes', () => {
    const mint = k();
    const d = Buffer.alloc(KIT_ROUNDS_LEN);
    KIT_ROUNDS_DISCRIMINATOR.copy(d, 0);
    d[8] = 1;
    mint.toBuffer().copy(d, 10);
    d.writeUInt32LE(493_000, 42);
    d.writeBigInt64LE(1_774_800_000n, 46);
    d.writeBigUInt64LE(900_000_000_000_000n, 54);
    d[62] = 3;
    [[10n, 1n], [20n, 2n], [30n, 3n]].forEach(([amount, paid], i) => {
      d.writeBigUInt64LE(amount!, 63 + 16 * i);
      d.writeBigUInt64LE(paid!, 71 + 16 * i);
    });
    const r = decodeKitRounds(d);
    expect(r).toMatchObject({ version: 1, round: 493_000, startedAt: 1_774_800_000, supply: 900_000_000_000_000n, count: 3, legs: [{ amount: 10n, paid: 1n }, { amount: 20n, paid: 2n }, { amount: 30n, paid: 3n }] });
    expect(r.mint.equals(mint)).toBe(true);
    expect(() => decodeKitRounds(Buffer.alloc(KIT_ROUNDS_LEN))).toThrow();
    const hook = new Uint8Array(64);
    const view = Buffer.from(hook.buffer);
    view.writeUInt32LE(7, 32);
    view.writeUInt32LE(6, 36);
    view.writeBigUInt64LE(500n, 40);
    view.writeBigUInt64LE(300n, 48);
    expect(roundDataOf(hook)).toEqual({ mark: 7, paid: 6, minCur: 500n, minPrev: 300n });
    expect(roundLeast(roundDataOf(hook), 1_000n, 7)).toEqual({ least: 300n, paid: false });
    expect(roundLeast(roundDataOf(hook), 400n, 8)).toEqual({ least: 400n, paid: false });
    expect(roundLeast({ mark: 7, paid: 7, minCur: 1n, minPrev: 1n }, 400n, 7).paid).toBe(true);
    expect(currentRound(7_200, 3_600)).toBe(2);
  });

  it('PayeesLegs (602 B) from §7.5.5’s offsets', () => {
    const d = Buffer.alloc(PAYEES_LEGS_LEN);
    PAYEES_LEGS_DISCRIMINATOR.copy(d, 0);
    d.writeBigUInt64LE(11n, 42 + 80 * 2 + 8 * 3);
    d.writeBigUInt64LE(5n, 522 + 8 * 4);
    const p = decodePayeesLegs(d);
    expect(p.owed[2]![3]).toBe(11n);
    expect(p.beneficiaryOwed[4]).toBe(5n);
  });

  it('QuoteReference (189 B) through the IDL', () => {
    const layout = (CODERS.launch.accounts as unknown as { accountLayouts: Map<string, { discriminator: number[]; layout: { encode: (v: unknown, b: Buffer) => number } }> }).accountLayouts.get('quoteReference')!;
    expect([...layout.discriminator]).toEqual([0x37, 0x30, 0x86, 0x62, 0x83, 0xec, 0xd4, 0xc6]);
    const [q, pool, who] = [k(), k(), k()];
    const d = Buffer.alloc(QUOTE_REFERENCE_LEN);
    Buffer.from(layout.discriminator).copy(d, 0);
    const value = { version: 1, bump: 254, quoteMint: q, venue: 3, via: 0, pool, registrant: who, registeredAt: new BN(1_792_565_000), depthAt: new BN('123000000000'), window: new BN(57_000_000), windowValue: new BN(42), paused: false, soldTotal: new BN(9), lamportsTotal: new BN(8), reserved: Array(32).fill(0) };
    expect(8 + layout.layout.encode(value, d.subarray(8))).toBe(QUOTE_REFERENCE_LEN);
    // Offsets as §7.5.5 gives them.
    expect(d[42]).toBe(3);
    expect(new PublicKey(d.subarray(44, 76)).equals(pool)).toBe(true);
    expect(d.readBigUInt64LE(116)).toBe(123_000_000_000n);
    const r = decodeQuoteReference(d);
    expect(r).toMatchObject({ venue: VENUE.clmm, via: 0, registeredAt: 1_792_565_000, depthAt: 123_000_000_000n, windowValue: 42n, paused: false, soldTotal: 9n, lamportsTotal: 8n });
  });

  it('CompanionLegs at 1,293 B, its legs’ new totals', () => {
    expect(COMPANION_LEGS_LEN).toBe(1_293);
    const layout = (CODERS.companion.accounts as unknown as { accountLayouts: Map<string, { discriminator: number[]; layout: { encode: (v: unknown, b: Buffer) => number } }> }).accountLayouts.get('companionLegs')!;
    type T = string | { array: [T, number] } | { defined: { name: string } };
    const types = (IDL.companion as unknown as { types: { name: string; type: { fields: { name: string; type: T }[] } }[] }).types;
    const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    const zero = (t: T): unknown => (typeof t === 'string' ? (t === 'pubkey' ? PublicKey.default : /^[ui](64|128)$/.test(t) ? new BN(0) : 0) : 'array' in t ? Array.from({ length: t.array[1] }, () => zero(t.array[0])) : Object.fromEntries(types.find((x) => x.name === t.defined.name)!.type.fields.map((f) => [camel(f.name), zero(f.type)])));
    const value = zero({ defined: { name: 'CompanionLegs' } }) as Record<string, unknown> & { legs: Record<string, unknown>[] };
    Object.assign(value, { version: 1, count: 1 });
    Object.assign(value.legs[0]!, { sharedTotal: new BN(12), swappedTotal: new BN(34), snowballLastAt: new BN(99) });
    const d = Buffer.alloc(COMPANION_LEGS_LEN);
    Buffer.from(layout.discriminator).copy(d, 0);
    layout.layout.encode(value, d.subarray(8));
    expect(decodeCompanionLegs(d).legs[0]).toMatchObject({ sharedTotal: 12n, swappedTotal: 34n, snowballLastAt: 99 });
    // §7.5.5's offsets: shared_total at 171, swapped_total at 179 of each LegPot (at 43 + 203·i).
    expect(d.readBigUInt64LE(43 + 171)).toBe(12n);
    expect(d.readBigUInt64LE(43 + 179)).toBe(34n);
  });

  it('a launch’s payouts byte (reserved[19]) and a kit’s reward kind, round, program and decimals (reserved[10..17])', () => {
    const launch = zeroAccount('launch', 'Launch', { reserved: Object.assign(Array(22).fill(0), { 18: 2, 19: 1 }) });
    expect(decodeLaunch(launch)).toMatchObject({ tokenQuoted: true, payouts: 1 });
    const kitReserved = Array(55).fill(0);
    kitReserved[9] = 2;
    kitReserved[10] = 2;
    Buffer.from([0x10, 0x0e, 0, 0]).forEach((b, i) => (kitReserved[11 + i] = b));
    kitReserved[15] = 1;
    kitReserved[16] = 8;
    const config = zeroAccount('kit', 'KitConfig', { reserved: kitReserved });
    expect(decodeKitConfig(config)).toMatchObject({ tokenQuoted: true, rewardKind: 2, roundSecs: 3_600, rewardProgram: 1, rewardDecimals: 8 });
  });
});

describe('the eleven events, typed', () => {
  const encodeIn = (program: 'launch' | 'kit' | 'companion', name: string, data: Record<string, unknown>): Buffer => {
    const idl = IDL[program] as unknown as { events: { name: string; discriminator: number[] }[] };
    return Buffer.concat([Buffer.from(idl.events.find((e) => e.name === name)!.discriminator), CODERS[program].types.encode(name.charAt(0).toLowerCase() + name.slice(1), data)]);
  };
  const read = (program: 'launch' | 'kit' | 'companion', name: string, data: Record<string, unknown>) => typedPayoutEvent({ program, ...decodeEventPayload(program, encodeIn(program, name, data))! } as never);
  it('reads each with its amounts and keys', () => {
    const [x, y, z] = [k(), k(), k()];
    expect(read('launch', 'TokenLaunchPayouts', { launch: x, mint: y, flags: 1, rewardKind: 3, holderRoundSecs: 0, ts: new BN(5) })).toEqual({ kind: 'launch.TokenLaunchPayouts', launch: x.toBase58(), mint: y.toBase58(), flags: 1, rewardKind: 3, holderRoundSecs: 0, ts: 5 });
    expect(read('launch', 'QuotePoolRegistered', { quoteMint: x, reference: y, venue: 1, via: 0, pool: z, replaced: null, depthLamports: new BN('150000000000'), feePpm: 2_500, registrant: x, ts: new BN(6) })).toMatchObject({ kind: 'launch.QuotePoolRegistered', venue: 1, replaced: null, depthLamports: 150_000_000_000n, feePpm: 2_500 });
    expect(read('launch', 'QuoteReferencePaused', { quoteMint: x, paused: true, ts: new BN(7) })).toMatchObject({ kind: 'launch.QuoteReferencePaused', paused: true });
    expect(read('launch', 'SwappedToSol', { launch: x, mint: y, quoteMint: z, authority: x, venue: 3, via: 1, amountIn: new BN(100), lamportsOut: new BN(90), minOut: new BN(80), price: new BN('18446744073709551616'), windowValue: new BN(90), ts: new BN(8) })).toMatchObject({ kind: 'launch.SwappedToSol', via: 1, amountIn: 100n, lamportsOut: 90n, price: 1n << 64n });
    expect(read('kit', 'LegsRewardsInstalled', { mint: x, kind: 2, roundSecs: 3_600, rewardMint: PublicKey.default, rewardVault: PublicKey.default })).toMatchObject({ kind: 'kit.LegsRewardsInstalled', rewardKind: 2, roundSecs: 3_600 });
    expect(read('kit', 'RoundStarted', { mint: x, round: 9, supply: new BN(1_000), amounts: [new BN(3), new BN(4)], ts: new BN(9) })).toMatchObject({ kind: 'kit.RoundStarted', round: 9, supply: 1_000n, amounts: [3n, 4n] });
    expect(read('kit', 'RoundPaid', { mint: x, round: 9, owner: y, balance: new BN(10), amounts: [new BN(1), new BN(0)] })).toMatchObject({ kind: 'kit.RoundPaid', owner: y.toBase58(), amounts: [1n, 0n] });
    expect(read('kit', 'RewardsSwappedToSol', { mint: x, index: 0, quoteMint: z, amountIn: new BN(55), lamports: new BN(44), shared: true })).toMatchObject({ kind: 'kit.RewardsSwappedToSol', lamports: 44n, shared: true });
    expect(read('companion', 'LegSharedWithHolders', { companion: x, index: 1, quoteMint: z, amount: new BN(70), bounty: new BN(1), cranker: y })).toMatchObject({ kind: 'companion.LegSharedWithHolders', amount: 70n });
    expect(read('companion', 'LegSwappedToSol', { companion: x, index: 2, quoteMint: z, part: 1, amountIn: new BN(5), lamports: new BN(4), cranker: y })).toMatchObject({ kind: 'companion.LegSwappedToSol', part: 1, lamports: 4n });
    expect(read('companion', 'LegPayeePaid', { companion: x, index: 0, payee: y, amount: new BN(3), owed: new BN(2) })).toMatchObject({ kind: 'companion.LegPayeePaid', payee: y.toBase58(), owed: 2n });
  });
});

// ---- the venues on mainnet pools ------------------------------------------------------------------------------

interface Fixture {
  accounts: Map<string, AccountInfo<Buffer>>;
  pool: PublicKey;
}
function fixture(name: string): Fixture {
  const text = readFileSync(new URL(`../vectors/venues/${name}.accounts`, import.meta.url), 'utf8');
  const accounts = new Map<string, AccountInfo<Buffer>>();
  let pool = PublicKey.default;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      const m = /pool (\w+)/.exec(line);
      if (m) pool = new PublicKey(m[1]!);
      continue;
    }
    const f = line.trim().split(' ');
    if (f.length < 5) continue;
    accounts.set(f[0]!, { owner: new PublicKey(f[1]!), lamports: Number(f[2]), executable: f[3] === '1', data: f[4] === '-' ? Buffer.alloc(0) : Buffer.from(f[4]!, 'base64'), rentEpoch: 0 });
  }
  return { accounts, pool };
}
const NOW = 1_792_567_700;
const read = (f: Fixture, token: PublicKey) => {
  const pool = f.accounts.get(f.pool.toBase58())!;
  for (const key of venueReads(({ [RAYDIUM_AMM]: 1, [RAYDIUM_CP]: 2, [RAYDIUM_CL]: 3 } as Record<string, 1 | 2 | 3>)[pool.owner.toBase58()] ?? 4, pool.data, token)) expect(f.accounts.has(key.toBase58()), `${key.toBase58()} in the fixture`).toBe(true);
  return marketOf(f.pool, pool, token, (key) => f.accounts.get(key.toBase58()) ?? null, NOW);
};
const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CP = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_CL = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const tokenOf = (f: Fixture, offsets: [number, number]): PublicKey => {
  const d = f.accounts.get(f.pool.toBase58())!.data;
  const [m0, m1] = offsets.map((o) => new PublicKey(d.subarray(o, o + 32)));
  return m0!.equals(a.NATIVE_MINT_KEY) ? m1! : m0!;
};

describe('the venue readers on mainnet pools (21 Oct 2026)', () => {
  it('Raydium AMM v4 RAY/WSOL: open, 0.25%, over 100 SOL deep, its price the vaults’ ratio', () => {
    const f = fixture('amm_v4_ray_wsol');
    const ray = tokenOf(f, [400, 432]);
    const m = read(f, ray)!;
    expect(m).not.toBeNull();
    expect([m.venue, m.open, m.feePpm, m.otherMint.toBase58()]).toEqual([VENUE.ammV4, true, 2_500n, a.NATIVE_MINT_KEY.toBase58()]);
    expect(m.depth).toBeGreaterThan(100_000_000_000n);
    expect(m.accounts).toHaveLength(5);
    // A sale of 1,000 RAY: its value, the minimum and the window's room.
    const value = valueAtQ64(1_000_000_000n, m.spot);
    expect(value).toBeGreaterThan(0n);
    expect(swapMinOut(value, m.feePpm, m.depth)).toBeLessThan(value);
    expect(swapWindowCap(m.feePpm, m.depth)).toBe((m.feePpm * m.depth) / 2_000_000n);
  });

  it('Raydium CPMM ZAI/WSOL: its token program and venue accounts', () => {
    const f = fixture('cpmm_zai_wsol');
    const m = read(f, tokenOf(f, [168, 200]))!;
    expect([m.venue, m.open]).toEqual([VENUE.cpmm, true]);
    expect(m.accounts).toHaveLength(7);
    expect(m.feePpm).toBeGreaterThanOrEqual(100n);
    expect(m.tokenProgram?.equals(a.SPL_TOKEN_2022_PROGRAM)).toBe(true);
  });

  it('Raydium CLMM TSLAx/WSOL: the virtual depth, the tick arrays the sale crosses', () => {
    const f = fixture('clmm_tslax_wsol');
    const m = read(f, tokenOf(f, [73, 105]))!;
    expect([m.venue, m.open]).toEqual([VENUE.clmm, true]);
    expect(m.depth).toBeGreaterThan(0n);
    expect(m.clmm).not.toBeNull();
    const ticks = clmmTickAccounts(m, (key) => f.accounts.has(key.toBase58()));
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) expect(f.accounts.get(t.toBase58())!.owner.toBase58()).toBe(RAYDIUM_CL);
  });

  it('Pump AMM ANSEM/WSOL: its fee from the fee program’s schedule, its sale’s 14 or 15 accounts', () => {
    const f = fixture('pump_ansem_wsol');
    const d = f.accounts.get(f.pool.toBase58())!.data;
    const m = read(f, new PublicKey(d.subarray(43, 75)))!;
    expect(m).not.toBeNull();
    expect([m.venue, m.open, m.tokenIs0]).toEqual([VENUE.pumpAmm, true, true]);
    expect([14, 15]).toContain(m.accounts.length);
    expect(m.feePpm).toBeGreaterThan(0n);
    expect(m.feePpm).toBeLessThanOrEqual(30_000n);
  });
});
