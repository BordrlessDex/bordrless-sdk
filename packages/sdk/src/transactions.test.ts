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
import { bridge, kit, launch, launchKeys, setComputeUnitLimit, setComputeUnitPrice, token } from './instructions.ts';
import { PACKET_DATA_SIZE, buildV0Transaction, checkProtocolLookupTable, createProtocolLookupTable, protocolLookupTable, transactionSize, v0KeyCounts } from './transactions.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const SOL = a.BRIDGED_SOL_MINT;
const DAY = 86_400;
const EVERY_RULE: LaunchRulesData = { holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 50, burnSellBps: 50, maxWalletBps: 500, creatorLockSecs: 30 * DAY, earlyWindowSecs: 60, earlyLockSecs: 3_600 };
/** The mainnet shape of every prepared transaction: a compute-unit limit and a priority price. */
const budget = () => [setComputeUnitLimit(1_400_000), setComputeUnitPrice(20_000n)];
const table = protocolLookupTable(k());
const blockhash = k().toBase58();

function measure(payer: PublicKey, ixs: Parameters<typeof buildV0Transaction>[1]): { keys: number; bytes: number; loaded: number } {
  const tx = buildV0Transaction(payer, [...budget(), ...ixs], blockhash, [table]);
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
    const authority = k();
    const setup = createProtocolLookupTable(authority, authority, 123);
    expect(setup.extend.length).toBe(1);
    expect(setup.create.programId.equals(a.ADDRESS_LOOKUP_TABLE_PROGRAM)).toBe(true);
    expect(setup.address.equals(PublicKey.findProgramAddressSync([authority.toBuffer(), Buffer.from(new BigUint64Array([123n]).buffer)], a.ADDRESS_LOOKUP_TABLE_PROGRAM)[0])).toBe(true);
  });
});
