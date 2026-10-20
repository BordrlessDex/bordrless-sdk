/**
 * Coins quoted in tokens (docs/token-quotes.md §2.4): every builder held to its IDL instruction (the
 * accounts in order with their writable and signer marks and fixed addresses, then the remaining
 * accounts; the data its discriminator and Borsh args), the addresses, the kind-2 `Pool` and the
 * `Legs` decoders, the four events and a leg swap's creator fee.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { decodeLegs, decodePool, isSplPool, POOL_QUOTE_KIND } from './accounts.ts';
import * as a from './addresses.ts';
import { CODERS, IDL } from './coders.ts';
import { decodeEventPayload } from './events.ts';
import { LEG_HOOK_FLAGS, LEG_SWAP_ACCOUNTS, legFeeAccount, legFeesAddress, legHookExtras, legPoolAddress, legQuoteVault, legsAddress, legSwapCutsOf, splPool, splVaultAddress, tokenLaunch, typedLegEvent, type LegKeys } from './legs.ts';

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

const instructionOf = (program: 'swap' | 'launch', name: string): IdlInstruction => (IDL[program] as unknown as { instructions: IdlInstruction[] }).instructions.find((i) => i.name === name)!;

/** The builder's fixed accounts against the IDL's: as many, in order, the same marks, the fixed addresses; returns what follows them. */
function heldToIdl(ix: TransactionInstruction, program: 'swap' | 'launch', name: string): TransactionInstruction['keys'] {
  const idl = instructionOf(program, name);
  expect(ix.programId.equals(program === 'swap' ? a.SWAP_PROGRAM : a.LAUNCH_PROGRAM)).toBe(true);
  expect(ix.keys.length).toBeGreaterThanOrEqual(idl.accounts.length);
  idl.accounts.forEach((acc, i) => {
    const meta = ix.keys[i]!;
    expect([acc.name, meta.isWritable, meta.isSigner], `${name} #${i}`).toEqual([acc.name, acc.writable === true, acc.signer === true]);
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
