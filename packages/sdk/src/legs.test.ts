/**
 * Coins quoted in tokens (docs/token-quotes.md §2.4): every builder held to its IDL instruction (the
 * accounts in order with their writable and signer marks and fixed addresses, then the remaining
 * accounts; the data its discriminator and Borsh args), the addresses, the kind-2 `Pool` and the
 * `Legs` decoders, the four events and a leg swap's creator fee.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { decodeKitConfig, decodeLegs, decodePool, isSplPool, kitModulesOf, POOL_QUOTE_KIND, type LaunchRulesData } from './accounts.ts';
import * as a from './addresses.ts';
import { CODERS, IDL } from './coders.ts';
import { decodeEventPayload } from './events.ts';
import { decodeHookAccountList, encodeHookAccountList, tokenHookOf } from './hooks.ts';
import { kitLegs, kitLegsRegistryList, kitLegsTokenHook, LEG_HOOK_FLAGS, LEG_SWAP_ACCOUNTS, LEG_SWAP_ACCOUNTS_WITH_KIT, legBaseSlice, legFeeAccount, legFeesAddress, legHookExtras, legLogEventsOf, legPoolAddress, legQuoteVault, legsAddress, legsHookExtras, legsHookSlice, legsLockDelay, legsMaxWalletHolds, legsSold, legsTradingOpenedAt, legSwapCutsOf, lockTimesInForce, NO_TOKEN_LAUNCH_RULES, splPool, splVaultAddress, TOKEN_LAUNCH_RULES_BYTES, tokenLaunch, tokenLaunchKitAccounts, typedLegEvent, type LegKeys } from './legs.ts';

const k = (): PublicKey => Keypair.generate().publicKey;

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
  args: { name: string }[];
}

type IdlProgram = 'swap' | 'launch' | 'kit';
const PROGRAM_OF: Record<IdlProgram, PublicKey> = { swap: a.SWAP_PROGRAM, launch: a.LAUNCH_PROGRAM, kit: a.KIT_PROGRAM };
const instructionOf = (program: IdlProgram, name: string): IdlInstruction => (IDL[program] as unknown as { instructions: IdlInstruction[] }).instructions.find((i) => i.name === name)!;

/**
 * The builder's fixed accounts against the IDL's: as many, in order, the same marks, the fixed addresses; returns what follows them.
 * `writable` names accounts the client may pass writable beyond the IDL's mark (a leg's mint when its rules burn).
 */
function heldToIdl(ix: TransactionInstruction, program: IdlProgram, name: string, writable: string[] = []): TransactionInstruction['keys'] {
  const idl = instructionOf(program, name);
  expect(ix.programId.equals(PROGRAM_OF[program])).toBe(true);
  expect(ix.keys.length).toBeGreaterThanOrEqual(idl.accounts.length);
  idl.accounts.forEach((acc, i) => {
    const meta = ix.keys[i]!;
    expect([acc.name, meta.isWritable, meta.isSigner], `${name} #${i}`).toEqual([acc.name, acc.writable === true || writable.includes(acc.name), acc.signer === true]);
    if (acc.address) expect(meta.pubkey.toBase58(), `${name} ${acc.name}`).toBe(acc.address);
  });
  // The event authority and the program, as #[event_cpi] appends them.
  expect(ix.keys[idl.accounts.length - 2]!.pubkey.equals(a.eventAuthority(ix.programId))).toBe(true);
  expect(ix.keys[idl.accounts.length - 1]!.pubkey.equals(ix.programId)).toBe(true);
  expect([...ix.data.subarray(0, 8)]).toEqual(idl.discriminator);
  return ix.keys.slice(idl.accounts.length);
}

const leg = (over: Partial<LegKeys> = {}): LegKeys => ({ mint: k(), quoteMint: k(), quoteProgram: a.SPL_TOKEN_2022_PROGRAM, lpFeeBps: 30, ...over });

describe('the addresses (§2.2, §2.4)', () => {
  it('derive the Legs, a leg’s fee account, its pool and its quote vault', () => {
    const keys = leg();
    expect(legsAddress(keys.mint).equals(PublicKey.findProgramAddressSync([Buffer.from('legs'), keys.mint.toBuffer()], a.LAUNCH_PROGRAM)[0])).toBe(true);
    expect(legFeesAddress(keys.mint, keys.quoteMint).equals(PublicKey.findProgramAddressSync([Buffer.from('leg-fees'), keys.mint.toBuffer(), keys.quoteMint.toBuffer()], a.LAUNCH_PROGRAM)[0])).toBe(true);
    expect(legFeeAccount(keys).equals(legFeesAddress(keys.mint, keys.quoteMint))).toBe(true);
    expect(legPoolAddress(keys).equals(a.poolAddress(keys.mint, keys.quoteMint, 30, a.LAUNCH_PROGRAM))).toBe(true);
    expect(legQuoteVault(keys).equals(a.associatedTokenAddress(legPoolAddress(keys), keys.quoteMint, a.SPL_TOKEN_2022_PROGRAM))).toBe(true);
    // The launchpad's hook authority, as open_leg names it (§2.4).
    expect(a.LAUNCH_HOOK_AUTHORITY.toBase58()).toBe('3dfEZLdjRcpTJ4RxPzgkqnqaG2FipRdaHgRW72AL6kqL');
  });
});

describe('the DEX’s builders against the IDL', () => {
  it('create_spl_pool: 18 accounts, then the base mint’s slice; CreatePoolArgs', () => {
    const [payer, authority, treasury, baseMint, quoteMint] = [k(), k(), k(), k(), k()];
    const args = { lpFeeBps: 30, hookProgram: a.LAUNCH_PROGRAM, hookFlags: LEG_HOOK_FLAGS, virtualBase: 0n, virtualQuote: 2_500_000_000n, baseAmount: 500_000_000_000_000n, quoteAmount: 0n, baseHookAccounts: 0, quoteHookAccounts: 0, hookData: new Uint8Array() };
    const ix = splPool.createSplPool({ payer, authority, treasury, baseMint, quoteMint, quoteProgram: a.SPL_TOKEN_PROGRAM, hookCaller: a.LAUNCH_HOOK_AUTHORITY }, args);
    expect(heldToIdl(ix, 'swap', 'create_spl_pool')).toEqual([]);
    const pool = a.poolAddress(baseMint, quoteMint, 30, a.LAUNCH_PROGRAM);
    expect([ix.keys[6]!.pubkey, ix.keys[7]!.pubkey, ix.keys[8]!.pubkey, ix.keys[9]!.pubkey].map(String)).toEqual([pool, a.vaultAddress(pool, baseMint), splVaultAddress(pool, quoteMint, a.SPL_TOKEN_PROGRAM), a.holdingAddress(baseMint, authority)].map(String));
    const decoded = CODERS.swap.instruction.decode(ix.data) as { name: string; data: { args: Record<string, unknown> } };
    expect(decoded.name).toBe('createSplPool');
    expect(decoded.data.args.hookFlags).toBe(0x3c1);
    expect((decoded.data.args.virtualQuote as BN).toString()).toBe('2500000000');
  });

  it('swap_spl on a leg: 16 accounts, then the leg’s four hook extras (20); SwapArgs in Borsh', () => {
    const keys = leg({ quoteProgram: a.SPL_TOKEN_PROGRAM });
    const [trader, recipient] = [k(), k()];
    const buy = tokenLaunch.legSwap(keys, trader, recipient, 1, 100_000_000n, 9n);
    expect(buy.keys.length).toBe(LEG_SWAP_ACCOUNTS);
    const extras = heldToIdl(buy, 'swap', 'swap_spl');
    expect(extras).toEqual(legHookExtras(keys.mint, keys.quoteMint));
    expect(extras.map((m) => [m.isWritable, m.isSigner])).toEqual([[true, false], [true, false], [true, false], [false, false]]);
    // A buy pays from the trader's account of the quote into the recipient's holding of the coin; the pool's hook is the launchpad, its signer the DEX's for it.
    expect([buy.keys[7]!.pubkey, buy.keys[8]!.pubkey, buy.keys[9]!.pubkey, buy.keys[10]!.pubkey, buy.keys[13]!.pubkey].map(String)).toEqual([a.holdingAddress(keys.mint, recipient), a.associatedTokenAddress(trader, keys.quoteMint, a.SPL_TOKEN_PROGRAM), a.LAUNCH_PROGRAM, a.dexHookSigner(a.LAUNCH_PROGRAM), a.SPL_TOKEN_PROGRAM].map(String));
    // The data: the discriminator, direction u8, amount_in u64, min_amount_out u64, two u8 counts, an empty Vec<u8>.
    const data = Buffer.alloc(8 + 1 + 8 + 8 + 1 + 1 + 4);
    Buffer.from(instructionOf('swap', 'swap_spl').discriminator).copy(data);
    data[8] = 1;
    data.writeBigUInt64LE(100_000_000n, 9);
    data.writeBigUInt64LE(9n, 17);
    expect(buy.data.equals(data)).toBe(true);
    // A sell takes from the trader's holding and delivers to the recipient's account of the quote.
    const sell = tokenLaunch.legSwap(keys, trader, recipient, 0, 5n, 1n);
    expect([sell.keys[7]!.pubkey, sell.keys[8]!.pubkey].map(String)).toEqual([a.holdingAddress(keys.mint, trader), a.associatedTokenAddress(recipient, keys.quoteMint, a.SPL_TOKEN_PROGRAM)].map(String));
  });

  it('collect_protocol_fees_spl: 12 accounts, the fee collector’s associated account of the quote; no args', () => {
    const [payer, pool, quoteMint, collector] = [k(), k(), k(), k()];
    const ix = splPool.collectProtocolFeesSpl(payer, pool, quoteMint, a.SPL_TOKEN_2022_PROGRAM, collector);
    expect(heldToIdl(ix, 'swap', 'collect_protocol_fees_spl')).toEqual([]);
    expect([ix.keys[4]!.pubkey, ix.keys[5]!.pubkey, ix.keys[6]!.pubkey].map(String)).toEqual([splVaultAddress(pool, quoteMint, a.SPL_TOKEN_2022_PROGRAM), collector, a.associatedTokenAddress(collector, quoteMint, a.SPL_TOKEN_2022_PROGRAM)].map(String));
    expect(ix.data.length).toBe(8);
  });
});

describe('the launchpad’s builders against the IDL', () => {
  it('create_token_launch: 12 accounts, then the quote mints in leg order; CreateTokenLaunchArgs in Borsh', () => {
    const [creator, mint, treasury, q0, q1] = [k(), k(), k(), k(), k()];
    const ix = tokenLaunch.createTokenLaunch(creator, mint, treasury, { name: 'Legs', symbol: 'LEG', uri: 'ipfs://x', creatorFeeBps: 100, virtualQuotes: [2_500_000_000n, 679_820_024n] }, [q0, q1]);
    const rest = heldToIdl(ix, 'launch', 'create_token_launch');
    expect(rest.map((m) => [m.pubkey.toBase58(), m.isWritable, m.isSigner])).toEqual([[q0.toBase58(), false, false], [q1.toBase58(), false, false]]);
    expect([ix.keys[4]!.pubkey, ix.keys[5]!.pubkey, ix.keys[6]!.pubkey].map(String)).toEqual([a.launchAddress(mint), legsAddress(mint), a.holdingAddress(mint, a.launchAddress(mint))].map(String));
    // Borsh: three strings (u32 length, bytes), u16, Vec<u64>.
    const str = (s: string) => Buffer.concat([Buffer.from(new Uint32Array([s.length]).buffer), Buffer.from(s)]);
    const u64s = Buffer.alloc(16);
    u64s.writeBigUInt64LE(2_500_000_000n, 0);
    u64s.writeBigUInt64LE(679_820_024n, 8);
    const expected = Buffer.concat([Buffer.from(instructionOf('launch', 'create_token_launch').discriminator), str('Legs'), str('LEG'), str('ipfs://x'), Buffer.from([100, 0]), Buffer.from([2, 0, 0, 0]), u64s]);
    expect(ix.data.equals(expected)).toBe(true);
  });

  it('open_leg(index): 23 accounts, the leg’s pool, vaults, fee account and registry; index u8', () => {
    const [payer, dexTreasury] = [k(), k()];
    const keys = leg();
    const ix = tokenLaunch.openLeg(payer, dexTreasury, keys, 4);
    expect(heldToIdl(ix, 'launch', 'open_leg')).toEqual([]);
    const pool = legPoolAddress(keys);
    expect([5, 6, 7, 9, 10, 11, 12, 18].map((i) => ix.keys[i]!.pubkey.toBase58())).toEqual([legFeeAccount(keys), a.holdingAddress(keys.mint, a.launchAddress(keys.mint)), a.launchRegistryAddress(pool), dexTreasury, pool, a.vaultAddress(pool, keys.mint), legQuoteVault(keys), a.SPL_TOKEN_2022_PROGRAM].map(String));
    expect([...ix.data.subarray(8)]).toEqual([4]);
  });

  it('claim_creator_fees_token(index): 12 accounts, the creator’s associated account of the quote; index u8', () => {
    const [payer, creator] = [k(), k()];
    const keys = leg({ quoteProgram: a.SPL_TOKEN_PROGRAM });
    const ix = tokenLaunch.claimCreatorFeesToken(payer, creator, keys, 2);
    expect(heldToIdl(ix, 'launch', 'claim_creator_fees_token')).toEqual([]);
    expect([ix.keys[4]!.pubkey, ix.keys[5]!.pubkey, ix.keys[6]!.pubkey].map(String)).toEqual([legFeeAccount(keys), creator, a.associatedTokenAddress(creator, keys.quoteMint, a.SPL_TOKEN_PROGRAM)].map(String));
    expect([...ix.data.subarray(8)]).toEqual([2]);
  });
});

describe('the accounts', () => {
  it('decode a kind-2 pool: its quote program and decimals from reserved[17] and [18]', async () => {
    const reserved = Array(60).fill(0);
    reserved[0] = 2;
    reserved[17] = 1;
    reserved[18] = 8;
    const z = new BN(0);
    const value = { version: 1, bump: 254, lpMintBump: 0, baseMint: k(), quoteMint: k(), lpMint: PublicKey.default, baseVault: k(), quoteVault: k(), hookProgram: a.LAUNCH_PROGRAM, hookFlags: LEG_HOOK_FLAGS, lpFeeBps: 30, protocolFeeBps: 0, baseReserve: new BN('500000000000000'), quoteReserve: z, virtualBase: z, virtualQuote: new BN(679_820_024), lpSupply: z, protocolFeesQuote: z, curve: true, creator: k(), createdAt: z, lastSwapAt: z, swapCount: z, baseVolume: z, quoteVolume: z, hookSignerBump: 255, feeModel: 1, protocolShareBps: 2_500, reserved };
    const data = await CODERS.swap.accounts.encode('pool', value);
    expect(data.length).toBe(411);
    const pool = decodePool(data);
    expect([pool.quoteKind, pool.quoteNative, isSplPool(pool), pool.splQuote?.program, pool.splQuote?.decimals, pool.splQuote?.programId.equals(a.SPL_TOKEN_2022_PROGRAM)]).toEqual([POOL_QUOTE_KIND.spl, false, true, 'token-2022', 8, true]);
    // reserved starts at byte 351 for a pool with a hook.
    expect([data[351], data[368], data[369]]).toEqual([2, 1, 8]);
    expect(decodePool(await CODERS.swap.accounts.encode('pool', { ...value, reserved: Array(60).fill(0) })).splQuote).toBeNull();
  });

  it('decode Legs (974 bytes): the first `count` legs', async () => {
    const [mint, launch, q0, pool0, fee0] = [k(), k(), k(), k(), k()];
    const zero = { quoteMint: PublicKey.default, quoteProgram: 0, decimals: 0, feeBump: 0, virtualQuote: new BN(0), share: new BN(0), pool: PublicKey.default, feeAccount: PublicKey.default, creatorFeesAccrued: new BN(0), creatorFeesClaimed: new BN(0), openedAt: new BN(0) };
    const legs = [{ ...zero, quoteMint: q0, quoteProgram: 1, decimals: 8, feeBump: 254, virtualQuote: new BN(679_820_024), share: new BN('500000000000000'), pool: pool0, feeAccount: fee0, creatorFeesAccrued: new BN(9), creatorFeesClaimed: new BN(4), openedAt: new BN(1_800_000_000) }, ...Array(5).fill(zero)];
    const data = await CODERS.launch.accounts.encode('legs', { version: 1, bump: 255, mint, launch, count: 1, opened: 1, legs, reserved: Array(64).fill(0) });
    expect(data.length).toBe(974);
    expect([...data.subarray(0, 8)]).toEqual([0x16, 0xbe, 0x5c, 0xdd, 0xc3, 0x3b, 0xab, 0xbd]);
    const decoded = decodeLegs(data);
    expect(decoded).toMatchObject({ count: 1, opened: 1 });
    expect(decoded.legs).toHaveLength(1);
    expect(decoded.legs[0]).toMatchObject({ decimals: 8, virtualQuote: 679_820_024n, share: 500_000_000_000_000n, creatorFeesAccrued: 9n, creatorFeesClaimed: 4n, openedAt: 1_800_000_000 });
    expect(decoded.legs[0]!.quoteProgram.equals(a.SPL_TOKEN_2022_PROGRAM) && decoded.legs[0]!.pool.equals(pool0)).toBe(true);
    // The leg's offsets of §2.4: legs[0] at 76, its pool at 76 + 51.
    expect(new PublicKey(data.subarray(76 + 51, 76 + 83)).equals(pool0)).toBe(true);
  });
});

describe('the events', () => {
  const encodeEvent = (program: 'swap' | 'launch', name: string, data: Record<string, unknown>): Buffer => {
    const idl = IDL[program] as unknown as { events: { name: string; discriminator: number[] }[] };
    const disc = Buffer.from(idl.events.find((e) => e.name === name)!.discriminator);
    return Buffer.concat([disc, CODERS[program].types.encode(name.charAt(0).toLowerCase() + name.slice(1), data)]);
  };

  it('SplPoolCreated, TokenLaunchCreated, LegOpened and LegCreatorFeesClaimed read typed', () => {
    const [pool, quoteMint, vault, launch, mint, creator, legsKey, fee, payer] = [k(), k(), k(), k(), k(), k(), k(), k(), k()];
    const spl = decodeEventPayload('swap', encodeEvent('swap', 'SplPoolCreated', { pool, quoteMint, quoteProgram: a.SPL_TOKEN_2022_PROGRAM, quoteDecimals: 8, quoteVault: vault }))!;
    expect(typedLegEvent({ program: 'swap', ...spl })).toEqual({ kind: 'swap.SplPoolCreated', pool: pool.toBase58(), quoteMint: quoteMint.toBase58(), quoteProgram: a.SPL_TOKEN_2022_PROGRAM.toBase58(), quoteDecimals: 8, quoteVault: vault.toBase58() });
    const terms = { quoteMint, quoteProgram: a.SPL_TOKEN_PROGRAM, decimals: 6, virtualQuote: new BN(2_500_000_000), share: new BN('500000000000000'), pool, feeAccount: fee };
    const created = decodeEventPayload('launch', encodeEvent('launch', 'TokenLaunchCreated', { launch, mint, creator, legsAccount: legsKey, name: 'Legs', symbol: 'LEG', uri: 'u', supply: new BN('1000000000000000'), decimals: 6, creatorFeeBps: 100, lpFeeBps: 30, launchFeeLamports: new BN(10_000_000), legs: [terms, terms], slot: new BN(9), ts: new BN(1_800_000_000) }))!;
    expect(created.name).toBe('tokenLaunchCreated');
    expect(typedLegEvent({ program: 'launch', ...created })).toMatchObject({ kind: 'launch.TokenLaunchCreated', mint: mint.toBase58(), creatorFeeBps: 100, lpFeeBps: 30, supply: 1_000_000_000_000_000n, legs: [{ decimals: 6, virtualQuote: 2_500_000_000n, pool: pool.toBase58() }, { share: 500_000_000_000_000n }], ts: 1_800_000_000 });
    const opened = decodeEventPayload('launch', encodeEvent('launch', 'LegOpened', { launch, mint, index: 1, quoteMint, pool, feeAccount: fee, virtualQuote: new BN(5), share: new BN(6), opened: 2, count: 2, payer, slot: new BN(9), ts: new BN(1) }))!;
    expect(typedLegEvent({ program: 'launch', ...opened })).toMatchObject({ kind: 'launch.LegOpened', index: 1, pool: pool.toBase58(), opened: 2, count: 2 });
    const claimed = decodeEventPayload('launch', encodeEvent('launch', 'LegCreatorFeesClaimed', { launch, mint, index: 0, quoteMint, creator, destination: vault, amount: new BN(7), claimedTotal: new BN(12), slot: new BN(9), ts: new BN(1) }))!;
    expect(typedLegEvent({ program: 'launch', ...claimed })).toMatchObject({ kind: 'launch.LegCreatorFeesClaimed', amount: 7n, claimedTotal: 12n });
    expect(typedLegEvent({ program: 'launch', name: 'launchCreated', data: {} })).toBeNull();
  });

  it('a leg swap’s creator fee is its delta to the leg’s fee account, either side', () => {
    const [mint, quoteMint] = [k(), k()];
    const fee = legFeesAddress(mint, quoteMint).toBase58();
    expect(legSwapCutsOf({ deltasIn: [{ holding: fee, amount: 1_000_000n }], deltasOut: [] }, mint, quoteMint)).toEqual({ creatorFee: 1_000_000n });
    expect(legSwapCutsOf({ deltasIn: [], deltasOut: [{ holding: fee, amount: 5n }, { holding: k().toBase58(), amount: 9n }] }, mint, quoteMint)).toEqual({ creatorFee: 5n });
  });
});

// ---- phase 1: rules on a coin quoted in tokens (docs/token-quotes.md §6.1.1) ------------------------------

const RULES: LaunchRulesData = { ...NO_TOKEN_LAUNCH_RULES, burnBuyBps: 100, burnSellBps: 50, maxWalletBps: 200, creatorLockSecs: 7 * 86_400, earlyWindowSecs: 60, earlyLockSecs: 3_600 };
const ro = (pubkey: PublicKey): [string, boolean, boolean] => [pubkey.toBase58(), false, false];
const rw = (pubkey: PublicKey): [string, boolean, boolean] => [pubkey.toBase58(), true, false];
const marks = (metas: TransactionInstruction['keys']): [string, boolean, boolean][] => metas.map((m) => [m.pubkey.toBase58(), m.isWritable, m.isSigner]);

describe('phase 1: the kit’s accounts and registry on a coin quoted in tokens', () => {
  it('the kit’s six accounts of create_token_launch, its three extras and its five-account slice (client.rs)', () => {
    const mint = k();
    // The token program's signer of the kit's callbacks, as `bordrless_kit::constants::TOKEN_HOOK_AUTHORITY` names it.
    expect(a.tokenHookSigner(a.KIT_PROGRAM).toBase58()).toBe('C2Y3B3hZTesJQqLYrZ7qoaZUoRmwYWh5Qh3MuFxruouE');
    expect(marks(tokenLaunchKitAccounts(mint))).toEqual([ro(a.KIT_PROGRAM), ro(a.tokenHookSigner(a.KIT_PROGRAM)), rw(a.kitConfigAddress(mint)), rw(a.kitRegistryAddress(mint)), ro(a.kitCallerPda(mint).address), ro(a.KIT_EVENT_AUTHORITY)]);
    expect(marks(legsHookExtras(mint))).toEqual([rw(a.kitConfigAddress(mint)), ro(a.KIT_PROGRAM), ro(legsAddress(mint))]);
    expect(marks(legsHookSlice(mint))).toEqual([ro(a.KIT_PROGRAM), ro(a.tokenHookSigner(a.KIT_PROGRAM)), ...marks(legsHookExtras(mint))]);
    expect(legBaseSlice(mint, 0)).toEqual([]);
    expect(legBaseSlice(mint, kitModulesOf(RULES))).toEqual(legsHookSlice(mint));
  });

  it('the kit’s registry for such a coin: its PDA entry resolves to the coin’s Legs, through the bytes as a transfer reads them', () => {
    const mint = k();
    const list = decodeHookAccountList(encodeHookAccountList(kitLegsRegistryList(mint)))!;
    expect(list.accounts).toHaveLength(3);
    // Any transfer of the coin (whatever its holdings) resolves the same three extras the DEX slice carries.
    const op = { mint, source: k(), destination: k(), authority: k() };
    const hook = tokenHookOf(a.KIT_PROGRAM, list, op);
    expect(hook.signer.equals(a.tokenHookSigner(a.KIT_PROGRAM))).toBe(true);
    expect(marks(hook.extras)).toEqual(marks(legsHookExtras(mint)));
    expect(marks(kitLegsTokenHook(mint, op.source, op.destination, op.authority).extras)).toEqual(marks(legsHookExtras(mint)));
  });

  it('init_legs: 9 accounts, signed by the kit-caller PDA; KitInitArgs in Borsh', () => {
    const [payer, mint, launch, pool, creator] = [k(), k(), k(), k(), k()];
    const caller = a.kitCallerPda(mint);
    const args = { launch, pool, creator, rewardMint: PublicKey.default, modules: 14, maxWalletBps: 200, creatorUnlockAt: new BN(1_800_604_800), earlyWindowEnd: new BN(1_800_000_060), earlyUnlockAt: new BN(1_800_003_600), kitCallerBump: caller.bump };
    const ix = kitLegs.initLegs(caller.address, payer, mint, args);
    expect(heldToIdl(ix, 'kit', 'init_legs')).toEqual([]);
    expect([ix.keys[0]!.pubkey, ix.keys[2]!.pubkey, ix.keys[3]!.pubkey, ix.keys[4]!.pubkey, ix.keys[5]!.pubkey].map(String)).toEqual([caller.address, mint, a.holdingAddress(mint, launch), a.kitConfigAddress(mint), a.kitRegistryAddress(mint)].map(String));
    const decoded = CODERS.kit.instruction.decode(ix.data) as { name: string; data: { args: Record<string, unknown> } };
    expect(decoded.name).toBe('initLegs');
    expect([decoded.data.args.modules, decoded.data.args.maxWalletBps, String(decoded.data.args.earlyUnlockAt)]).toEqual([14, 200, '1800003600']);
  });
});

describe('phase 1: the launchpad’s builders with rules against the IDL', () => {
  const baseArgs = { name: 'Legs', symbol: 'LEG', uri: 'ipfs://x', creatorFeeBps: 100, virtualQuotes: [2_500_000_000n, 679_820_024n, 1n] };

  it('create_token_launch with rules that install the kit: 12 accounts, the quote mints, then the kit’s six; the rules last in the data', () => {
    const [creator, mint, treasury, q0, q1, q2] = [k(), k(), k(), k(), k(), k()];
    const ix = tokenLaunch.createTokenLaunch(creator, mint, treasury, { ...baseArgs, rules: RULES }, [q0, q1, q2]);
    const rest = heldToIdl(ix, 'launch', 'create_token_launch');
    expect(marks(rest)).toEqual([ro(q0), ro(q1), ro(q2), ...marks(tokenLaunchKitAccounts(mint))]);
    // The data is today's, then `LaunchRules` in Borsh: five u16 and three u32.
    const without = tokenLaunch.createTokenLaunch(creator, mint, treasury, baseArgs, [q0, q1, q2]);
    const tail = Buffer.alloc(TOKEN_LAUNCH_RULES_BYTES);
    [0, 0, 100, 50, 200].forEach((v, i) => tail.writeUInt16LE(v, 2 * i));
    [7 * 86_400, 60, 3_600].forEach((v, i) => tail.writeUInt32LE(v, 10 + 4 * i));
    expect(ix.data.equals(Buffer.concat([without.data, tail]))).toBe(true);
    const decoded = CODERS.launch.instruction.decode(ix.data) as { name: string; data: { args: { rules: Record<string, unknown> } } };
    expect(decoded.data.args.rules).toMatchObject({ burnBuyBps: 100, burnSellBps: 50, maxWalletBps: 200, creatorLockSecs: 604_800, earlyWindowSecs: 60, earlyLockSecs: 3_600 });
  });

  it('create_token_launch with a burn alone: the rules in the data, no kit accounts (modules 0)', () => {
    const [creator, mint, treasury, q0] = [k(), k(), k(), k()];
    const burn = { ...NO_TOKEN_LAUNCH_RULES, burnBuyBps: 100 };
    const ix = tokenLaunch.createTokenLaunch(creator, mint, treasury, { ...baseArgs, virtualQuotes: [1n], rules: burn }, [q0]);
    expect(marks(heldToIdl(ix, 'launch', 'create_token_launch'))).toEqual([ro(q0)]);
    const without = tokenLaunch.createTokenLaunch(creator, mint, treasury, { ...baseArgs, virtualQuotes: [1n] }, [q0]);
    expect(ix.data.length).toBe(without.data.length + TOKEN_LAUNCH_RULES_BYTES);
    expect(ix.data.subarray(0, without.data.length).equals(without.data)).toBe(true);
  });

  it('create_token_launch with no rules, null or all zero: exactly today’s data and accounts', () => {
    const [creator, mint, treasury, q0] = [k(), k(), k(), k()];
    const args = { ...baseArgs, virtualQuotes: [1n] };
    const none = tokenLaunch.createTokenLaunch(creator, mint, treasury, args, [q0]);
    for (const rules of [null, NO_TOKEN_LAUNCH_RULES]) {
      const ix = tokenLaunch.createTokenLaunch(creator, mint, treasury, { ...args, rules }, [q0]);
      expect(ix.data.equals(none.data)).toBe(true);
      expect(marks(ix.keys)).toEqual(marks(none.keys));
    }
  });

  it('open_leg on a coin with a kit: 23 accounts, then the kit, its token signer and the kit config (w)', () => {
    const [payer, dexTreasury] = [k(), k()];
    const keys = leg();
    const ix = tokenLaunch.openLeg(payer, dexTreasury, keys, 2, kitModulesOf(RULES));
    expect(marks(heldToIdl(ix, 'launch', 'open_leg'))).toEqual([ro(a.KIT_PROGRAM), ro(a.tokenHookSigner(a.KIT_PROGRAM)), rw(a.kitConfigAddress(keys.mint))]);
    expect(tokenLaunch.openLeg(payer, dexTreasury, keys, 2, 0).keys).toEqual(tokenLaunch.openLegWithoutKit(payer, dexTreasury, keys, 2).keys);
  });

  it('a leg swap with the kit: the coin’s slice on its side (out on a buy, in on a sell) before the leg’s four extras, 25 accounts; the mint writable when it burns', () => {
    const keys = leg({ quoteProgram: a.SPL_TOKEN_PROGRAM });
    const [trader, recipient] = [k(), k()];
    const buy = tokenLaunch.legSwap(keys, trader, recipient, 1, 100_000_000n, 9n, RULES);
    expect(buy.keys.length).toBe(LEG_SWAP_ACCOUNTS_WITH_KIT);
    expect(marks(heldToIdl(buy, 'swap', 'swap_spl', ['base_mint']))).toEqual([...marks(legsHookSlice(keys.mint)), ...marks(legHookExtras(keys.mint, keys.quoteMint))]);
    // direction, amount_in, min_amount_out, then in_hook_accounts and out_hook_accounts.
    expect([buy.data[25], buy.data[26]]).toEqual([0, 5]);
    const sell = tokenLaunch.legSwap(keys, trader, recipient, 0, 5n, 1n, RULES);
    expect(heldToIdl(sell, 'swap', 'swap_spl', ['base_mint'])).toHaveLength(9);
    expect([sell.data[25], sell.data[26]]).toEqual([5, 0]);
    // Max wallet and the locks without a burn: the slice, the mint read-only.
    const noBurn = tokenLaunch.legSwap(keys, trader, recipient, 1, 1n, 0n, { ...RULES, burnBuyBps: 0, burnSellBps: 0 });
    expect(heldToIdl(noBurn, 'swap', 'swap_spl')).toHaveLength(9);
    // A burn alone: no kit, so no slice, but the mint writable for the hook's burn.
    const burnOnly = tokenLaunch.legSwap(keys, trader, recipient, 1, 1n, 0n, { ...NO_TOKEN_LAUNCH_RULES, burnSellBps: 10 });
    expect(burnOnly.keys.length).toBe(LEG_SWAP_ACCOUNTS);
    expect(heldToIdl(burnOnly, 'swap', 'swap_spl', ['base_mint'])).toEqual(legHookExtras(keys.mint, keys.quoteMint));
    expect([burnOnly.data[25], burnOnly.data[26]]).toEqual([0, 0]);
    // No rules: as before phase 1.
    expect(tokenLaunch.legSwap(keys, trader, recipient, 1, 1n, 0n, null).keys).toEqual(tokenLaunch.legSwap(keys, trader, recipient, 1, 1n, 0n).keys);
  });
});

describe('phase 1: the accounts and events', () => {
  it('Legs bytes 910..974: lift_at u64 at 910, lifted at 918, each leg’s coins sold i64 at 926 + 8·i', async () => {
    const [mint, launch] = [k(), k()];
    const zero = { quoteMint: PublicKey.default, quoteProgram: 0, decimals: 0, feeBump: 0, virtualQuote: new BN(0), share: new BN(0), pool: PublicKey.default, feeAccount: PublicKey.default, creatorFeesAccrued: new BN(0), creatorFeesClaimed: new BN(0), openedAt: new BN(0) };
    const reserved = Buffer.alloc(64);
    reserved.writeBigUInt64LE(800_000_000_000_000n, 0);
    reserved[8] = 1;
    reserved.writeBigInt64LE(500_000_000_000_000n, 16);
    reserved.writeBigInt64LE(-20_000_000n, 24);
    reserved.writeBigInt64LE(300_000_000_000_000n, 32);
    const data = await CODERS.launch.accounts.encode('legs', { version: 1, bump: 255, mint, launch, count: 3, opened: 3, legs: Array(6).fill(zero), reserved: [...reserved] });
    expect([data.readBigUInt64LE(910), data[918], data.readBigInt64LE(926), data.readBigInt64LE(934)]).toEqual([800_000_000_000_000n, 1, 500_000_000_000_000n, -20_000_000n]);
    const legs = decodeLegs(data);
    expect([legs.liftAt, legs.lifted, legs.legs.map((l) => l.sold)]).toEqual([800_000_000_000_000n, true, [500_000_000_000_000n, -20_000_000n, 300_000_000_000_000n]]);
    const before = decodeLegs(await CODERS.launch.accounts.encode('legs', { version: 1, bump: 255, mint, launch, count: 1, opened: 1, legs: Array(6).fill(zero), reserved: Array(64).fill(0) }));
    expect([before.liftAt, before.lifted, before.legs[0]!.sold]).toEqual([0n, false, 0n]);
    // Max wallet holds a buy until the byte says it lifted, or until the legs' recorded sales reach lift_at (that trade lifts it).
    expect(legsSold(legs)).toBe(799_999_980_000_000n);
    expect([legsMaxWalletHolds(legs), legsMaxWalletHolds({ ...legs, lifted: false }), legsMaxWalletHolds({ ...legs, lifted: false, liftAt: 799_999_980_000_000n })]).toEqual([false, true, false]);
  });

  it('the locks run from when trading opens (F1): the latest leg’s opened_at once every leg is open, the clock before', async () => {
    const [mint, launch] = [k(), k()];
    const zero = { quoteMint: PublicKey.default, quoteProgram: 0, decimals: 0, feeBump: 0, virtualQuote: new BN(0), share: new BN(0), pool: PublicKey.default, feeAccount: PublicKey.default, creatorFeesAccrued: new BN(0), creatorFeesClaimed: new BN(0), openedAt: new BN(0) };
    const at = (opened: number, times: number[]) => CODERS.launch.accounts.encode('legs', { version: 1, bump: 255, mint, launch, count: 3, opened, legs: [...times.map((t) => ({ ...zero, openedAt: new BN(t) })), ...Array(6 - times.length).fill(zero)], reserved: Array(64).fill(0) });
    const CREATED = 1_800_000_000;
    // Two of three open: trading has not opened; the delay is the clock's.
    const partial = decodeLegs(await at(2, [CREATED + 1, CREATED + 61, 0]));
    expect([legsTradingOpenedAt(partial), legsLockDelay(partial, CREATED, CREATED + 500)]).toEqual([null, 500]);
    // All open, the last 5,000 s after the launch: the delay is fixed there, whatever the clock.
    const open = decodeLegs(await at(3, [CREATED + 1, CREATED + 5_000, CREATED + 61]));
    expect([legsTradingOpenedAt(open), legsLockDelay(open, CREATED, CREATED + 99_999)]).toEqual([CREATED + 5_000, 5_000]);
    // Opened in the launch's own second (or before it, never): no delay.
    expect(legsLockDelay(decodeLegs(await at(3, [CREATED, CREATED, CREATED - 3])), CREATED, CREATED + 10)).toBe(0);
    // Each kept time moved by the delay, 0 staying 0.
    expect(lockTimesInForce({ creatorUnlockAt: CREATED + 7 * 86_400, earlyWindowEnd: 0, earlyUnlockAt: 0 }, 5_000)).toEqual({ creatorUnlockAt: CREATED + 7 * 86_400 + 5_000, earlyWindowEnd: 0, earlyUnlockAt: 0 });
  });

  it('a kit config marked quoted in tokens (reserved[9] = 2)', async () => {
    const coder = CODERS.kit.accounts;
    const disc = (IDL.kit as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((x) => x.name === 'KitConfig')!.discriminator;
    const zero = Buffer.alloc(coder.size('kitConfig'));
    Buffer.from(disc).copy(zero);
    const raw = coder.decode('kitConfig', zero) as Record<string, unknown>;
    const reserved = [...(raw.reserved as number[])];
    expect(decodeKitConfig(Buffer.from(await coder.encode('kitConfig', { ...raw, reserved }))).tokenQuoted).toBe(false);
    reserved[9] = 2;
    expect(decodeKitConfig(Buffer.from(await coder.encode('kitConfig', { ...raw, reserved }))).tokenQuoted).toBe(true);
  });

  const encodeEvent = (name: string, data: Record<string, unknown>): Buffer => {
    const idl = IDL.launch as unknown as { events: { name: string; discriminator: number[] }[] };
    const disc = Buffer.from(idl.events.find((e) => e.name === name)!.discriminator);
    return Buffer.concat([disc, CODERS.launch.types.encode(name.charAt(0).toLowerCase() + name.slice(1), data)]);
  };

  it('TokenLaunchRules reads typed, with and without a kit config', () => {
    const [launch, mint, kitConfig] = [k(), k(), k()];
    const rules = { ...RULES };
    const body = { launch, mint, rules, modules: 14, kitConfig, creatorUnlockAt: new BN(1_800_604_800), earlyWindowEnd: new BN(1_800_000_060), earlyUnlockAt: new BN(1_800_003_600), liftAt: new BN('800000000000000'), ts: new BN(1_800_000_000) };
    const ev = decodeEventPayload('launch', encodeEvent('TokenLaunchRules', body))!;
    expect(ev.name).toBe('tokenLaunchRules');
    expect(typedLegEvent({ program: 'launch', ...ev })).toEqual({ kind: 'launch.TokenLaunchRules', launch: launch.toBase58(), mint: mint.toBase58(), rules, modules: 14, kitConfig: kitConfig.toBase58(), creatorUnlockAt: 1_800_604_800, earlyWindowEnd: 1_800_000_060, earlyUnlockAt: 1_800_003_600, liftAt: 800_000_000_000_000n, ts: 1_800_000_000 });
    const burn = decodeEventPayload('launch', encodeEvent('TokenLaunchRules', { ...body, rules: { ...NO_TOKEN_LAUNCH_RULES, burnBuyBps: 100 }, modules: 0, kitConfig: null, creatorUnlockAt: new BN(0), earlyWindowEnd: new BN(0), earlyUnlockAt: new BN(0), liftAt: new BN(0) }))!;
    expect(typedLegEvent({ program: 'launch', ...burn })).toMatchObject({ modules: 0, kitConfig: null, liftAt: 0n, rules: { burnBuyBps: 100, maxWalletBps: 0 } });
  });

  it('TokenLaunchLocks (F1) reads typed: when trading opened, the delay and the times in force', () => {
    const [launch, mint] = [k(), k()];
    const ev = decodeEventPayload('launch', encodeEvent('TokenLaunchLocks', { launch, mint, tradingOpenedAt: new BN(1_800_005_000), delay: new BN(5_000), creatorUnlockAt: new BN(1_800_609_800), earlyWindowEnd: new BN(1_800_005_060), earlyUnlockAt: new BN(1_800_008_600), ts: new BN(1_800_005_000) }))!;
    expect(ev.name).toBe('tokenLaunchLocks');
    expect(typedLegEvent({ program: 'launch', ...ev })).toEqual({ kind: 'launch.TokenLaunchLocks', launch: launch.toBase58(), mint: mint.toBase58(), tradingOpenedAt: 1_800_005_000, delay: 5_000, creatorUnlockAt: 1_800_609_800, earlyWindowEnd: 1_800_005_060, earlyUnlockAt: 1_800_008_600, ts: 1_800_005_000 });
    expect([...(IDL.launch as unknown as { events: { name: string; discriminator: number[] }[] }).events.find((e) => e.name === 'TokenLaunchLocks')!.discriminator]).toEqual([0xcf, 0xc4, 0x41, 0x47, 0x1c, 0x56, 0x4b, 0x61]);
  });

  it('LegsMaxWalletLifted from the launchpad’s `Program data:` log, only while the launchpad runs', () => {
    const [launch, mint, pool] = [k(), k(), k()];
    const payload = encodeEvent('LegsMaxWalletLifted', { launch, mint, pool, sold: new BN('800000000000123'), liftAt: new BN('800000000000000'), ts: new BN(1_800_000_000) }).toString('base64');
    const [swap, launchpad, token] = [a.SWAP_PROGRAM.toBase58(), a.LAUNCH_PROGRAM.toBase58(), a.TOKEN_PROGRAM.toBase58()];
    const logs = [
      `Program ${swap} invoke [1]`,
      'Program log: Instruction: SwapSpl',
      `Program ${launchpad} invoke [2]`,
      `Program ${token} invoke [3]`,
      `Program data: ${payload}`,
      `Program ${token} success`,
      `Program data: ${payload}`,
      `Program ${launchpad} consumed 21000 of 180000 compute units`,
      `Program ${launchpad} success`,
      `Program data: ${payload}`,
      `Program ${swap} success`,
    ];
    const events = legLogEventsOf(logs, 7);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ordinal: 7, program: 'launch', programId: launchpad, name: 'legsMaxWalletLifted' });
    expect(typedLegEvent(events[0]!)).toEqual({ kind: 'launch.LegsMaxWalletLifted', launch: launch.toBase58(), mint: mint.toBase58(), pool: pool.toBase58(), sold: 800_000_000_000_123n, liftAt: 800_000_000_000_000n, ts: 1_800_000_000 });
    // Another launchpad event logged the same way is not read.
    const other = encodeEvent('LegOpened', { launch, mint, index: 1, quoteMint: k(), pool, feeAccount: k(), virtualQuote: new BN(5), share: new BN(6), opened: 2, count: 2, payer: k(), slot: new BN(9), ts: new BN(1) }).toString('base64');
    expect(legLogEventsOf([`Program ${launchpad} invoke [1]`, `Program data: ${other}`, `Program ${launchpad} success`])).toEqual([]);
  });
});
