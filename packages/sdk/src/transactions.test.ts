/**
 * The v0 builder with the protocol lookup table, held to the paths the programs' runtime test
 * measured (programs-summary §7): built here exactly as `programs/tests/tests/runtime.rs` builds
 * them (a compute-unit limit and price in front, the same instructions, the same 18-address table),
 * each must come out with the same number of keys and the same size on the wire. Two compilers
 * agreeing to the byte on seven paths means the builders pass the same accounts, flags and data as
 * the Rust ones.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as a from './addresses.ts';
import { NO_LAUNCH_RULES, type LaunchRulesData } from './accounts.ts';
import { MAX_CUSTOM_HOOK_EXTRAS, kitTokenHook } from './hooks.ts';
import { companion, type GameArgs } from './companion.ts';
import { lotteryHook } from './lotteryHook.ts';
import { bridge, kit, launch, launchKeys, setComputeUnitLimit, setComputeUnitPrice, token } from './instructions.ts';
import { PACKET_DATA_SIZE, buildV0Transaction, checkProtocolLookupTable, companionReady, createProtocolLookupTable, protocolLookupTable, transactionSize, v0KeyCounts } from './transactions.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const SOL = a.BRIDGED_SOL_MINT;
const DAY = 86_400;
const EVERY_RULE: LaunchRulesData = { holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 50, burnSellBps: 50, maxWalletBps: 500, creatorLockSecs: 30 * DAY, earlyWindowSecs: 60, earlyLockSecs: 3_600 };
/** The mainnet shape of every prepared transaction: a compute-unit limit and a priority price. */
const budget = () => [setComputeUnitLimit(1_400_000), setComputeUnitPrice(20_000n)];
const table = protocolLookupTable(k());
/** The table as mainnet held it before the companion addresses were appended: the sizes below are measured against it, the bound every path must keep. */
const core = protocolLookupTable(k(), a.PROTOCOL_LOOKUP_TABLE.slice(0, 18));
const blockhash = k().toBase58();

function measure(payer: PublicKey, ixs: Parameters<typeof buildV0Transaction>[1], tables = [core]): { keys: number; bytes: number; loaded: number } {
  const tx = buildV0Transaction(payer, [...budget(), ...ixs], blockhash, tables);
  const counts = v0KeyCounts(tx);
  return { keys: counts.total, bytes: transactionSize(tx), loaded: counts.loaded };
}

describe('v0 transactions with the protocol lookup table reproduce the measured paths (programs-summary §7)', () => {
  const creator = k();
  const mint = k();
  const keys = launchKeys(mint, SOL, 30, EVERY_RULE);
  const buyer = k();

  it('create_launch, every module: 32 keys, 1,043 bytes (and over the limit without the table)', () => {
    const ix = launch.createLaunch(creator, mint, k(), SOL, 30, { name: 'Launch EVRY', symbol: 'EVRY', uri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', creatorFeeBps: 50, virtualQuote: 28_125_000_000n, rules: EVERY_RULE });
    // One byte more than before 2026-10-07: the optional `launch_config` slot (the launch's id, already a static key) is one more account index.
    expect(measure(creator, [ix])).toMatchObject({ keys: 32, bytes: 1_043 });
    // Without the table it does not fit, even with no budget instruction at all (the summary's 1,366 bytes is "holders first" with another symbol and a compute-unit limit).
    const bare = buildV0Transaction(creator, [ix], blockhash, []);
    expect(transactionSize(bare)).toBe(1_329);
    expect(transactionSize(bare) > PACKET_DATA_SIZE).toBe(true);
  });

  it('a buy with SOL in, every rule: 28 keys, 805 bytes', () => {
    const ixs = [token.createHolding(buyer, SOL, buyer), bridge.wrapSol(buyer, 500_000_000n), token.createHolding(buyer, mint, buyer), launch.swap(keys, buyer, buyer, 1, 500_000_000n, 0n)];
    expect(measure(buyer, ixs)).toMatchObject({ keys: 28, bytes: 805 });
  });

  it('a sell with SOL out, every rule: 28 keys, 787 bytes', () => {
    const ixs = [token.createHolding(buyer, SOL, buyer), launch.swap(keys, buyer, buyer, 0, 1_000_000n, 0n), bridge.unwrapSolAbove(buyer, 0n)];
    expect(measure(buyer, ixs)).toMatchObject({ keys: 28, bytes: 787 });
  });

  it('sell 100% with a claim and an unwrap: 30 keys, 843 bytes, the kit kept static', () => {
    const ixs = [token.createHolding(buyer, SOL, buyer), launch.swap(keys, buyer, buyer, 0, 1_000_000n, 0n), kit.claim(buyer, mint, SOL), bridge.unwrapSolAbove(buyer, 0n)];
    expect(measure(buyer, ixs)).toMatchObject({ keys: 30, bytes: 843 });
    const tx = buildV0Transaction(buyer, [...budget(), ...ixs], blockhash, [table]);
    expect(tx.message.staticAccountKeys.some((key) => key.equals(a.KIT_PROGRAM))).toBe(true);
  });

  it('a buy that graduates, every rule: 35 keys, 970 bytes', () => {
    const last = k();
    const grad = k();
    const gkeys = launchKeys(grad, SOL, 30, EVERY_RULE);
    const ixs = [token.createHolding(last, SOL, last), bridge.wrapSol(last, 50_000_000_000n), token.createHolding(last, grad, last), launch.swap(gkeys, last, last, 1, 50_000_000_000n, 0n), launch.graduate(last, grad, SOL, 30, gkeys.modules)];
    expect(measure(last, ixs)).toMatchObject({ keys: 35, bytes: 970 });
  });

  it('a claim of one mint and the unwrap: 19 keys, 558 bytes', () => {
    const claimer = k();
    const ixs = [token.createHolding(claimer, SOL, claimer), kit.claim(claimer, mint, SOL), bridge.unwrapSolAbove(claimer, 123n)];
    expect(measure(claimer, ixs)).toMatchObject({ keys: 19, bytes: 558 });
  });

  it('a wallet-to-wallet transfer of a kit token, every rule: 11 keys, 446 bytes, the kit loaded from the table', () => {
    const [from, to] = [k(), k()];
    const ix = token.transfer(from, a.holdingAddress(mint, from), a.holdingAddress(mint, to), mint, 1_000n, kitTokenHook(mint, a.rewardVaultAddress(mint, SOL)));
    expect(measure(from, [ix])).toMatchObject({ keys: 11, bytes: 446 });
    const tx = buildV0Transaction(from, [...budget(), ix], blockhash, [table]);
    expect(tx.message.staticAccountKeys.some((key) => key.equals(a.KIT_PROGRAM))).toBe(false);
  });

  it('the extended table makes every path smaller: the launch, buys and sells load the launch, swap and token programs from it', () => {
    const ix = launch.createLaunch(creator, mint, k(), SOL, 30, { name: 'Every rule', symbol: 'EVRY', uri: 'ipfs://x', creatorFeeBps: 50, virtualQuote: 28_125_000_000n, rules: EVERY_RULE });
    const before = measure(creator, [ix]).bytes;
    const after = measure(creator, [ix], [table]).bytes;
    expect(after).toBeLessThan(before);
    expect(before - after).toBeGreaterThanOrEqual(60);
  });

  it('a launch with a custom hook fits with at most MAX_CUSTOM_HOOK_EXTRAS registry extras, at the longest metadata the site uploads', () => {
    const hook = k();
    // A name of 32 bytes, a symbol of 10, an ipfs:// link of 66 (a CIDv1): the most the form sends.
    const longest = { name: 'N'.repeat(32), symbol: 'S'.repeat(10), uri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', creatorFeeBps: 50, virtualQuote: 28_125_000_000n, rules: NO_LAUNCH_RULES };
    const bytes = (n: number): number => {
      const extras = Array.from({ length: n }, () => ({ pubkey: k(), isSigner: false, isWritable: true }));
      return measure(creator, [launch.createLaunch(creator, k(), k(), SOL, 30, longest, { launchConfig: k(), customHook: { program: hook, extras } })]).bytes;
    };
    expect(bytes(MAX_CUSTOM_HOOK_EXTRAS)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(bytes(MAX_CUSTOM_HOOK_EXTRAS + 1)).toBeGreaterThan(PACKET_DATA_SIZE);
  });

  it('a launch through a companion fits with the 22-address table, a custom hook with MAX_CUSTOM_HOOK_EXTRAS included (the companion program refuses a custom hook; the wire would not)', () => {
    const launcher = k();
    const longest = { name: 'N'.repeat(32), symbol: 'S'.repeat(10), uri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', creatorFeeBps: 50, virtualQuote: 28_125_000_000n, rules: NO_LAUNCH_RULES };
    const bytes = (options: Parameters<typeof launch.createLaunch>[6]): number => {
      const mint = k();
      const inner = launch.createLaunch(a.companionCreatorAddress(mint), mint, k(), SOL, 30, longest, options);
      return measure(launcher, [companion.launch(launcher, mint, inner, longest)], [table]).bytes;
    };
    const extras = (n: number) => Array.from({ length: n }, () => ({ pubkey: k(), isSigner: false, isWritable: true }));
    // Inline rules 950 bytes; from a config 982; a config naming a hook with 4 registry extras 1,213 of 1,232.
    expect(bytes(undefined)).toBe(950);
    expect(bytes({ launchConfig: k(), customHook: null })).toBe(982);
    const withHook = bytes({ launchConfig: k(), customHook: { program: k(), extras: extras(MAX_CUSTOM_HOOK_EXTRAS) } });
    expect(withHook).toBe(1_213);
    expect(withHook).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  it('a lottery coin: its setup, its launch through the companion and every game step fit, at the sizes companion_game.rs measured', () => {
    // As `a_game_launch_fits_mainnet_limits` (bordrless-programs, programs/tests/tests/companion_game.rs) builds
    // them, with the 22-address table: the same instructions, the same keys, so the same bytes on the wire.
    const launcher = k();
    const mint = k();
    const hook = a.LOTTERY_HOOK_PROGRAM;
    const createArgs = { split: { buybackBps: 10_000, holdersBps: 0, beneficiaryBps: 0 }, bountyBps: 50, maxBuyback: 1_000_000_000n, buybackInterval: 60, vestSecs: 0, fund: 500_000_000n };
    const game: GameArgs = { kind: 'lottery', hook, split: { buybackBps: 3_000, holdersBps: 0, beneficiaryBps: 0 }, potBps: 7_000, roundSecs: 3_600, minPot: 100_000_000n, prizeBps: 10_000, claimWindowSecs: 300, maxAttempts: 6 };
    const setup = buildV0Transaction(launcher, [companion.create(launcher, launcher, mint, createArgs), lotteryHook.prepare(launcher, mint, game.roundSecs), companion.createGame(launcher, mint, game)], blockhash, [table]);
    expect(transactionSize(setup)).toBe(765);
    // The launch from a config naming the hook, at the longest metadata the programs' test sends (a Pinata URI of 128 bytes).
    const args = { name: 'N'.repeat(32), symbol: 'TENCHARSXX', uri: `https://gateway.pinata.cloud/ipfs/${'b'.repeat(94)}`, creatorFeeBps: 200, virtualQuote: 28_125_000_000n, rules: NO_LAUNCH_RULES };
    const inner = launch.createLaunch(a.companionCreatorAddress(mint), mint, k(), SOL, 30, args, { launchConfig: k(), customHook: lotteryHook.accounts(mint) });
    const launched = measure(launcher, [companion.launch(launcher, mint, inner, args)], [table]);
    expect([launched.keys, launched.bytes]).toEqual([35, 1_177]);
    // Every step, as the keeper sends it.
    const keeper = k();
    const keys = launchKeys(mint, SOL, 30, NO_LAUNCH_RULES, lotteryHook.accounts(mint));
    const seed = new Uint8Array(32).fill(3);
    const treasury = new PublicKey('9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR');
    const steps: [string, PublicKey, Parameters<typeof buildV0Transaction>[1], number][] = [
      ['draw (commit and request)', keeper, [companion.draw(keeper, mint, hook, 1, { slot: 2n, hash: new Uint8Array(32).fill(3) }, treasury)], 731],
      ['draw with the paid request', keeper, [companion.draw(keeper, mint, hook, 1, { slot: 2n, hash: new Uint8Array(32).fill(3) }, treasury, new Uint8Array(32).fill(4))], 764],
      ['reveal', keeper, [companion.reveal(keeper, mint, hook, a.oraoRequestAddress(seed))], 469],
      ['claim_prize', keeper, [companion.claimPrize(keeper, mint, hook, 0, k())], 586],
      ['expire', keeper, [companion.expire(keeper, mint, hook, a.oraoRequestAddress(seed))], 469],
      ['claim_fees', keeper, [companion.claimFees(keeper, mint, hook)], 530],
      ['buyback', keeper, [companion.buyback(keeper, keys, false)], 886],
      ['dev_buy', launcher, [companion.devBuy(launcher, keys, 1_000_000_000n, 1n)], 891],
      ['release', keeper, [companion.release(keeper, keys, false, launcher)], 648],
    ];
    for (const [name, payer, ixs, bytes] of steps) expect(measure(payer, ixs, [table]).bytes, name).toBe(bytes);
  });

  it('keeps every invoked program static and loads only what it may', () => {
    const ix = kit.claim(buyer, mint, SOL);
    const tx = buildV0Transaction(buyer, [ix], blockhash, [table]);
    const statics = tx.message.staticAccountKeys.map(String);
    expect(statics).toContain(a.KIT_PROGRAM.toBase58());
    // The kit's event and hook authorities and the token event authority load from the table.
    const lookup = tx.message.addressTableLookups[0]!;
    const loaded = [...lookup.writableIndexes, ...lookup.readonlyIndexes].map((i) => a.PROTOCOL_LOOKUP_TABLE[i]!.toBase58());
    expect(loaded).toEqual(expect.arrayContaining([a.KIT_EVENT_AUTHORITY, a.KIT_HOOK_AUTHORITY, a.TOKEN_EVENT_AUTHORITY, SOL].map(String)));
    expect(loaded).not.toContain(a.KIT_PROGRAM.toBase58());
  });

  it('checks a fetched table and builds the instructions that create and extend it', () => {
    expect(checkProtocolLookupTable(table)).toBeNull();
    const shuffled = protocolLookupTable(k(), [...a.PROTOCOL_LOOKUP_TABLE].reverse());
    expect(checkProtocolLookupTable(shuffled)).toMatch(/at index 0/);
    // The older table of 18 still serves everything but a companion launch; a wrong 19th does not.
    const older = protocolLookupTable(k(), a.PROTOCOL_LOOKUP_TABLE.slice(0, 18));
    expect([checkProtocolLookupTable(older), companionReady(older), companionReady(table)]).toEqual([null, false, true]);
    expect(checkProtocolLookupTable(protocolLookupTable(k(), a.PROTOCOL_LOOKUP_TABLE.slice(0, 17)))).toMatch(/at index 17/);
    expect(checkProtocolLookupTable(protocolLookupTable(k(), [...a.PROTOCOL_LOOKUP_TABLE.slice(0, 18), k()]))).toMatch(/at index 18/);
    const authority = k();
    const setup = createProtocolLookupTable(authority, authority, 123);
    // 22 addresses: two extends, a chunk per instruction.
    expect(setup.extend.length).toBe(2);
    expect(setup.create.programId.equals(a.ADDRESS_LOOKUP_TABLE_PROGRAM)).toBe(true);
    expect(setup.address.equals(PublicKey.findProgramAddressSync([authority.toBuffer(), Buffer.from(new BigUint64Array([123n]).buffer)], a.ADDRESS_LOOKUP_TABLE_PROGRAM)[0])).toBe(true);
  });
});
