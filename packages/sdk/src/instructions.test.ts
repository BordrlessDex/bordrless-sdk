/**
 * Every builder held to the v2 IDLs (the account lists of programs-summary §3 are rendered from the
 * same IDLs): the number of accounts, each one's signer and writable flags, every fixed address, the
 * event authority and the program at the end, the discriminator; then the remaining-account rules of
 * §2.2 to §2.6, the registries of §2.4 and every fixed address of §5 against its derivation.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey, type AccountMeta, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { FIXED_ADDRESSES, HALF_LIFE, HOOK_SIGNERS, PROTOCOL_LOOKUP_TABLE_ADDRESSES, RULE_BOUNDS } from '@bordrless/shared';
import * as a from './addresses.ts';
import { NO_LAUNCH_RULES, type LaunchRulesData } from './accounts.ts';
import { CODERS, IDL, type ProgramName } from './coders.ts';
import { MAX_CUSTOM_HOOK_EXTRAS, customHookLaunchAccounts, customHookSlice, decodeHookAccountList, encodeHookAccountList, fetchTokenHook, kitHookExtras, kitHookSlice, kitRegistryList, kitTokenHook, launchPoolRegistryList, resolveCustomHookAccounts, resolveHookAccounts, tokenHookOf, tokenHookSlice } from './hooks.ts';
import { PROTOCOL_PROGRAMS, buildCreateConfig, configProblems, programUpgradeInfoOf, registryLengthProblem } from './inspect.ts';
import { TAX_HOOK_FLAGS, bridge, halfLife, kit, launch, launchKeys, launchKeysOf, swap, taxHook, token } from './instructions.ts';
import { halfLifeSince } from './accounts.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const disc = (name: string): Buffer => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const SOL = a.BRIDGED_SOL_MINT;
const DAY = 86_400;
/** Every rule (the programs' `presets::every_rule`): holder rewards 1% both sides, burn 0.5% both sides, max wallet 5%, creator lock 30 days, early-buyer lock 60 s until 1 h. */
const EVERY_RULE: LaunchRulesData = { holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 50, burnSellBps: 50, maxWalletBps: 500, creatorLockSecs: 30 * DAY, earlyWindowSecs: 60, earlyLockSecs: 3_600 };

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
}
type RawIdl = { address: string; instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[] };

const PROGRAM_ID: Record<ProgramName, PublicKey> = { token: a.TOKEN_PROGRAM, swap: a.SWAP_PROGRAM, bridge: a.BRIDGE_PROGRAM, launch: a.LAUNCH_PROGRAM, kit: a.KIT_PROGRAM, taxHook: a.TAX_HOOK_PROGRAM, halfLife: a.HALF_LIFE_PROGRAM };

/**
 * The instruction against the IDL's: its fixed accounts in order with their flags and addresses, and
 * `remaining` accounts after them. `writableMints` are the IDL's read-only accounts a client passes
 * writable on purpose (a swap's mints when the pool hook burns). An absent optional account (the
 * program's id) is read-only and signs nothing.
 */
function holdToIdl(program: ProgramName, name: string, ix: TransactionInstruction, remaining: number, writableMints: string[] = []): void {
  const idl = IDL[program] as unknown as RawIdl;
  const def = idl.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`${program} has no ${name}`);
  const programId = PROGRAM_ID[program];
  expect(ix.programId.equals(programId), `${name}: program`).toBe(true);
  expect([...ix.data.subarray(0, 8)], `${name}: discriminator`).toEqual(def.discriminator);
  expect([...ix.data.subarray(0, 8)], `${name}: sha256 discriminator`).toEqual([...disc(name)]);
  expect(ix.keys.length, `${name}: ${def.accounts.length} accounts and ${remaining} remaining`).toBe(def.accounts.length + remaining);
  def.accounts.forEach((acc, i) => {
    const meta = ix.keys[i]!;
    const where = `${name}[${i}] ${acc.name}`;
    if (acc.optional && meta.pubkey.equals(programId)) {
      expect([meta.isSigner, meta.isWritable], `${where} absent`).toEqual([false, false]);
      return;
    }
    expect(meta.isSigner, `${where} signer`).toBe(acc.signer === true);
    expect(meta.isWritable, `${where} writable`).toBe(acc.writable === true || writableMints.includes(acc.name));
    if (acc.address) expect(meta.pubkey.toBase58(), `${where} address`).toBe(acc.address);
    if (acc.name === 'event_authority' && i === def.accounts.length - 2) expect(meta.pubkey.equals(a.eventAuthority(programId)), `${where}`).toBe(true);
    if (acc.name === 'program' && i === def.accounts.length - 1) expect(meta.pubkey.equals(programId), `${where}`).toBe(true);
  });
}

const keyAt = (ix: TransactionInstruction, i: number): string => ix.keys[i]!.pubkey.toBase58();
const metaOf = (m: AccountMeta): [string, boolean, boolean] => [m.pubkey.toBase58(), m.isSigner, m.isWritable];

describe('fixed addresses (programs-summary §5) are their derivations', () => {
  it('derives every fixed address and hook signer to the constants the programs compiled in', () => {
    const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey): [string, number] => {
      const [key, bump] = PublicKey.findProgramAddressSync(seeds, program);
      return [key.toBase58(), bump];
    };
    const s = (t: string): Buffer => Buffer.from(t);
    // Address and bump of each, as §5 lists them.
    expect(pda([s('__event_authority')], a.TOKEN_PROGRAM)).toEqual([FIXED_ADDRESSES.tokenEventAuthority, 254]);
    expect(pda([s('__event_authority')], a.SWAP_PROGRAM)).toEqual([FIXED_ADDRESSES.swapEventAuthority, 254]);
    expect(pda([s('__event_authority')], a.BRIDGE_PROGRAM)).toEqual([FIXED_ADDRESSES.bridgeEventAuthority, 255]);
    expect(pda([s('__event_authority')], a.LAUNCH_PROGRAM)).toEqual([FIXED_ADDRESSES.launchEventAuthority, 253]);
    expect(pda([s('__event_authority')], a.KIT_PROGRAM)).toEqual([FIXED_ADDRESSES.kitEventAuthority, 253]);
    expect(pda([s('hook-authority'), a.KIT_PROGRAM.toBuffer()], a.TOKEN_PROGRAM)).toEqual([HOOK_SIGNERS.tokenForKit, 254]);
    expect(pda([s('hook-authority'), a.TAX_HOOK_PROGRAM.toBuffer()], a.TOKEN_PROGRAM)).toEqual([HOOK_SIGNERS.tokenForTaxHook, 255]);
    expect(pda([s('hook-authority'), a.LAUNCH_PROGRAM.toBuffer()], a.SWAP_PROGRAM)).toEqual([HOOK_SIGNERS.dexForLaunch, 252]);
    expect(pda([s('config')], a.SWAP_PROGRAM)).toEqual([FIXED_ADDRESSES.swapConfig, 254]);
    expect(pda([s('config')], a.BRIDGE_PROGRAM)).toEqual([FIXED_ADDRESSES.bridgeConfig, 250]);
    expect(pda([s('wrapper'), a.NATIVE_MINT_KEY.toBuffer()], a.BRIDGE_PROGRAM)).toEqual([FIXED_ADDRESSES.solWrapper, 255]);
    expect(pda([s('wrapped'), a.NATIVE_MINT_KEY.toBuffer()], a.BRIDGE_PROGRAM)).toEqual([FIXED_ADDRESSES.bridgedSolMint, 254]);
    expect(pda([s('sol-vault')], a.BRIDGE_PROGRAM)).toEqual([FIXED_ADDRESSES.solVault, 255]);
    expect(pda([s('config')], a.LAUNCH_PROGRAM)).toEqual([FIXED_ADDRESSES.launchConfig, 253]);
    expect(pda([s('hook-authority')], a.LAUNCH_PROGRAM)).toEqual([FIXED_ADDRESSES.launchHookAuthority, 255]);
    expect(pda([s('hook-authority')], a.KIT_PROGRAM)).toEqual([FIXED_ADDRESSES.kitHookAuthority, 255]);
    // The SDK's own derivations agree.
    expect([a.tokenHookSigner(a.KIT_PROGRAM), a.TOKEN_HOOK_SIGNER_KIT].map(String)).toEqual([HOOK_SIGNERS.tokenForKit, HOOK_SIGNERS.tokenForKit]);
    expect(a.tokenHookSigner(a.TAX_HOOK_PROGRAM).toBase58()).toBe(HOOK_SIGNERS.tokenForTaxHook);
    expect([a.dexHookSigner(a.LAUNCH_PROGRAM), a.DEX_HOOK_SIGNER_LAUNCH].map(String)).toEqual([HOOK_SIGNERS.dexForLaunch, HOOK_SIGNERS.dexForLaunch]);
    expect(a.KIT_HOOK_AUTHORITY.toBase58()).toBe(FIXED_ADDRESSES.kitHookAuthority);
    expect(a.LAUNCH_HOOK_AUTHORITY.toBase58()).toBe(FIXED_ADDRESSES.launchHookAuthority);
    expect([a.SWAP_CONFIG, a.BRIDGE_CONFIG, a.LAUNCH_CONFIG, a.SOL_WRAPPER, a.SOL_VAULT, a.BRIDGED_SOL_MINT].map(String)).toEqual([FIXED_ADDRESSES.swapConfig, FIXED_ADDRESSES.bridgeConfig, FIXED_ADDRESSES.launchConfig, FIXED_ADDRESSES.solWrapper, FIXED_ADDRESSES.solVault, FIXED_ADDRESSES.bridgedSolMint]);
    expect([a.TOKEN_EVENT_AUTHORITY, a.SWAP_EVENT_AUTHORITY, a.BRIDGE_EVENT_AUTHORITY, a.LAUNCH_EVENT_AUTHORITY, a.KIT_EVENT_AUTHORITY].map(String)).toEqual([FIXED_ADDRESSES.tokenEventAuthority, FIXED_ADDRESSES.swapEventAuthority, FIXED_ADDRESSES.bridgeEventAuthority, FIXED_ADDRESSES.launchEventAuthority, FIXED_ADDRESSES.kitEventAuthority]);
    // One signer per hook program: another hook's is different.
    const other = k();
    expect(a.tokenHookSigner(other).equals(a.TOKEN_HOOK_SIGNER_KIT)).toBe(false);
    expect(a.dexHookSigner(a.KIT_PROGRAM).equals(a.DEX_HOOK_SIGNER_LAUNCH)).toBe(false);
  });

  it('lists the 18 addresses of the protocol lookup table in the order the programs test it', () => {
    expect(a.PROTOCOL_LOOKUP_TABLE.map(String)).toEqual([
      '69vhpnkYjtiJgdfU7QsA5Ww7V8FWtvPcZ2r4znuyByvq',
      'C2Y3B3hZTesJQqLYrZ7qoaZUoRmwYWh5Qh3MuFxruouE',
      '9cBz2tsg7FwopSsd6HzvtbiL6b7B46eLG436etkB7cyx',
      '6Ztfr97cUewdViXDXdZUsQq4pz7MYdygvK1WijALjZ5q',
      '2XLvgczuVACmvvjfRLLAcLwMzFHutbAAro61zZKP8fsx',
      'EiUK62AP8DwUJWBosf7Ceyih3sGAicZxmsmcBftHzM8n',
      'Dwf4C8tTMYwicp8cU5MYcTtMQVVJTN7W3LcXCQ1UEhMs',
      '3ta59VvLDKLnCKMhYihiC3fQ7W9jPKty6xfx3h5puHGS',
      'EAcZR2i8A6BbnKRdWuyMVDTuiNkD6qc4RkFpxUYJ9Qba',
      '6ogQR9x8o86egutFri8ev6Kx6reTDg8YdwPmvkW29efh',
      '3dfEZLdjRcpTJ4RxPzgkqnqaG2FipRdaHgRW72AL6kqL',
      '5n25iAaXFsjs4UgGQM6fCiRhaQcCVQ1L5BgyRZ7UrmaE',
      '9abhxVTuwck5Ux79act3e2Vkfem7Q4zBwATMctUvHvuE',
      '2repKA1JgDkBo4AffscVee342dcBcH6c2yfpUTRrAiEN',
      '14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH',
      'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i',
      '11111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    ]);
    expect(PROTOCOL_LOOKUP_TABLE_ADDRESSES.length).toBe(18);
  });

  it('derives the per-mint accounts of the kit and the launch', () => {
    const mint = k();
    const kitConfig = PublicKey.findProgramAddressSync([Buffer.from('kit'), mint.toBuffer()], a.KIT_PROGRAM)[0];
    expect(a.kitConfigAddress(mint).equals(kitConfig)).toBe(true);
    expect(a.kitRegistryAddress(mint).equals(PublicKey.findProgramAddressSync([Buffer.from('bordrless-hook-accounts'), mint.toBuffer()], a.KIT_PROGRAM)[0])).toBe(true);
    const [caller, bump] = PublicKey.findProgramAddressSync([Buffer.from('kit-caller'), mint.toBuffer()], a.LAUNCH_PROGRAM);
    expect(a.kitCallerPda(mint)).toEqual({ address: caller, bump });
    expect(a.kitCallerAddress(mint).equals(caller)).toBe(true);
    // The reward vault is the holder vault: the kit config's holding of bridged SOL.
    expect(a.rewardVaultAddress(mint, SOL).equals(a.holdingAddress(SOL, kitConfig))).toBe(true);
    expect(a.holderVaultAddress(mint, SOL).equals(a.rewardVaultAddress(mint, SOL))).toBe(true);
    // The launch pool's four extras.
    expect(a.launchHookExtras(mint, SOL).map(metaOf)).toEqual([
      [a.launchAddress(mint).toBase58(), false, true],
      [a.holdingAddress(SOL, a.launchAddress(mint)).toBase58(), false, true],
      [a.holderVaultAddress(mint, SOL).toBase58(), false, true],
      [kitConfig.toBase58(), false, false],
    ]);
  });
});

describe('registries (programs-summary §2.4)', () => {
  it('writes the kit registry as 81 bytes and resolves it to the two extras', () => {
    const mint = k();
    const vault = a.rewardVaultAddress(mint, SOL);
    for (const rewardVault of [vault, null]) {
      const list = kitRegistryList(a.kitConfigAddress(mint), rewardVault);
      const bytes = encodeHookAccountList(list);
      expect(bytes.length).toBe(81);
      const decoded = decodeHookAccountList(bytes)!;
      expect(decoded).toEqual(list);
      const prefix = [a.TOKEN_HOOK_SIGNER_KIT, mint, k(), k(), k()];
      expect(resolveHookAccounts(decoded, prefix).map(metaOf)).toEqual(kitHookExtras(mint, rewardVault).map(metaOf));
    }
    expect(kitHookExtras(mint, null)[1]!.pubkey.equals(a.KIT_PROGRAM)).toBe(true);
    // A kit mint's DEX slice: the kit, the token program's signer for it, then the two extras.
    expect(kitHookSlice(mint, vault).map(metaOf)).toEqual([
      [a.KIT_PROGRAM.toBase58(), false, false],
      [HOOK_SIGNERS.tokenForKit, false, false],
      [a.kitConfigAddress(mint).toBase58(), false, true],
      [vault.toBase58(), false, false],
    ]);
  });

  it('writes the launch pool registry as 186 bytes and resolves it to the four extras', () => {
    const mint = k();
    const pool = a.launchPoolAddress(mint, SOL, 30);
    const list = launchPoolRegistryList(a.holderVaultAddress(mint, SOL), a.kitConfigAddress(mint));
    const bytes = encodeHookAccountList(list);
    expect(bytes.length).toBe(186);
    const decoded = decodeHookAccountList(bytes)!;
    const resolved = resolveHookAccounts(decoded, [a.DEX_HOOK_SIGNER_LAUNCH, pool, mint, SOL, k()]);
    expect(resolved.map(metaOf)).toEqual(a.launchHookExtras(mint, SOL).map(metaOf));
    // The indices the hook names its deltas by: the quote holding at 6, the holder vault at 7.
    expect(resolved[6 - 5]!.pubkey.equals(a.launchQuoteAddress(mint, SOL))).toBe(true);
    expect(resolved[7 - 5]!.pubkey.equals(a.holderVaultAddress(mint, SOL))).toBe(true);
    expect(decodeHookAccountList(Buffer.from('not a registry'))).toBeNull();
  });

  it('resolves a token hook against the operation, the token program signer first', () => {
    const mint = k();
    const [owner, other] = [k(), k()];
    // A registry naming the destination owner and the prefix's source: resolved per operation.
    const list = { version: 1, accounts: [{ writable: true, source: { kind: 'pda' as const, program: a.TAX_HOOK_PROGRAM, seeds: [{ kind: 'literal' as const, bytes: Buffer.from('tax') }, { kind: 'account' as const, index: 1 }] } }, { writable: false, source: { kind: 'pda' as const, program: a.TAX_HOOK_PROGRAM, seeds: [{ kind: 'destinationOwner' as const }, { kind: 'account' as const, index: 0 }] } }] };
    const op = { mint, source: a.holdingAddress(mint, owner), destination: a.holdingAddress(mint, other), authority: owner, sourceOwner: owner, destinationOwner: other };
    const hook = tokenHookOf(a.TAX_HOOK_PROGRAM, list, op);
    expect(hook.signer.toBase58()).toBe(HOOK_SIGNERS.tokenForTaxHook);
    expect(hook.extras[0]!.pubkey.equals(a.taxConfigAddress(mint))).toBe(true);
    expect(hook.extras[1]!.pubkey.equals(PublicKey.findProgramAddressSync([other.toBuffer(), hook.signer.toBuffer()], a.TAX_HOOK_PROGRAM)[0])).toBe(true);
    expect(tokenHookSlice(hook).length).toBe(4);
    expect(tokenHookSlice(null)).toEqual([]);
    expect(tokenHookOf(a.KIT_PROGRAM, kitRegistryList(a.kitConfigAddress(mint), null), op)).toEqual(kitTokenHook(mint, null));
  });

  it('reads a mint\'s hook and registry over RPC (fetchTokenHook)', async () => {
    const [owner, other] = [k(), k()];
    const kitMint = k();
    const plainMint = k();
    const vault = a.rewardVaultAddress(kitMint, SOL);
    const mintAccount = async (hookProgram: PublicKey | null): Promise<Buffer> =>
      CODERS.token.accounts.encode('mint', { version: 1, decimals: 6, supply: new BN(1), maxSupply: new BN(1), mintAuthority: null, freezeAuthority: null, hookAuthority: null, metadataAuthority: null, hookProgram, hookFlags: hookProgram ? 145 : 0, name: 'N', symbol: 'S', uri: 'u', createdAt: new BN(1), creator: owner, hookSignerBump: hookProgram ? 255 : 0, reserved: Array(31).fill(0) });
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>([
      [kitMint.toBase58(), { owner: a.TOKEN_PROGRAM, data: await mintAccount(a.KIT_PROGRAM) }],
      [plainMint.toBase58(), { owner: a.TOKEN_PROGRAM, data: await mintAccount(null) }],
      [a.kitRegistryAddress(kitMint).toBase58(), { owner: a.KIT_PROGRAM, data: encodeHookAccountList(kitRegistryList(a.kitConfigAddress(kitMint), vault)) }],
    ]);
    const connection = { getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null } as unknown as Connection;
    const op = (mint: PublicKey) => ({ mint, source: a.holdingAddress(mint, owner), destination: a.holdingAddress(mint, other), authority: owner, sourceOwner: owner, destinationOwner: other });
    expect(await fetchTokenHook(connection, op(kitMint))).toEqual(kitTokenHook(kitMint, vault));
    expect(await fetchTokenHook(connection, op(plainMint))).toBeNull();
    expect(await fetchTokenHook(connection, op(k()))).toBeNull();
  });
});

describe('builders hold to the v2 IDLs (programs-summary §3)', () => {
  it('token: transfer, mint_to and burn take the hook and its signer in two slots; close_holding takes the mint; write_hook_data', () => {
    const [owner, other, mint] = [k(), k(), k()];
    const src = a.holdingAddress(mint, owner);
    const dst = a.holdingAddress(mint, other);
    const vault = a.rewardVaultAddress(mint, SOL);
    const hook = kitTokenHook(mint, vault);
    // Without a hook: the token program's id in both slots, nothing remaining.
    const plain = token.transfer(owner, src, dst, mint, 5n);
    holdToIdl('token', 'transfer', plain, 0);
    expect([keyAt(plain, 4), keyAt(plain, 5)]).toEqual([a.TOKEN_PROGRAM.toBase58(), a.TOKEN_PROGRAM.toBase58()]);
    // A kit mint: the kit, 6EsVn9…, then kit_config (w) and the reward vault (r).
    const hooked = token.transfer(owner, src, dst, mint, 5n, hook);
    holdToIdl('token', 'transfer', hooked, 2);
    expect([keyAt(hooked, 4), keyAt(hooked, 5)]).toEqual([a.KIT_PROGRAM.toBase58(), HOOK_SIGNERS.tokenForKit]);
    expect(hooked.keys.slice(8).map(metaOf)).toEqual(kitHookExtras(mint, vault).map(metaOf));
    expect(hooked.keys[3]!.isWritable).toBe(false);
    holdToIdl('token', 'mint_to', token.mintTo(owner, mint, dst, 5n, hook), 2);
    holdToIdl('token', 'mint_to', token.mintTo(owner, mint, dst, 5n), 0);
    holdToIdl('token', 'burn', token.burn(owner, src, mint, 5n, hook), 2);
    holdToIdl('token', 'burn', token.burn(owner, src, mint, 5n), 0);
    const close = token.closeHolding(owner, mint, src, owner);
    holdToIdl('token', 'close_holding', close, 0);
    expect(keyAt(close, 1)).toBe(mint.toBase58());
    const write = token.writeHookData(a.KIT_HOOK_AUTHORITY, mint, src, new Uint8Array(64).fill(7));
    holdToIdl('token', 'write_hook_data', write, 0);
    expect([...write.data.subarray(8)]).toEqual(Array(64).fill(7));
    expect(() => token.writeHookData(a.KIT_HOOK_AUTHORITY, mint, src, new Uint8Array(63))).toThrow(RangeError);
    holdToIdl('token', 'create_holding', token.createHolding(owner, mint, owner), 0);
    holdToIdl('token', 'create_mint', token.createMint(owner, mint, { decimals: 6, name: 'N', symbol: 'S', uri: 'u', maxSupply: 10n, mintAuthority: owner, freezeAuthority: null, hookProgram: a.KIT_PROGRAM, hookFlags: 145, hookAuthority: null, metadataAuthority: null }), 0);
    holdToIdl('token', 'approve', token.approve(owner, src, other, 1n), 0);
    holdToIdl('token', 'revoke', token.revoke(owner, src), 0);
    holdToIdl('token', 'set_frozen', token.setFrozen(owner, mint, src, true), 0);
    const setAuthority = token.setAuthority(owner, mint, 'hook', null);
    holdToIdl('token', 'set_authority', setAuthority, 0);
    // AuthorityKind::Hook is 2; no new authority is Borsh `None`.
    expect([...setAuthority.data.subarray(8)]).toEqual([2, 0]);
    const setHook = token.setHook(owner, mint, a.KIT_PROGRAM, 145);
    holdToIdl('token', 'set_hook', setHook, 0);
    expect([setHook.data[8], setHook.data.subarray(9, 41).equals(a.KIT_PROGRAM.toBuffer()), setHook.data.readUInt16LE(41)]).toEqual([1, true, 145]);
    holdToIdl('token', 'update_metadata', token.updateMetadata(owner, mint, 'name', null, null), 0);
  });

  it('DEX: swap with per-side slices and mint writability, liquidity, create_pool, collect_protocol_fees, finalize_curve', () => {
    const [trader, base] = [k(), k()];
    const pool = a.launchPoolAddress(base, SOL, 30);
    const keys = { trader, pool, baseMint: base, quoteMint: SOL, traderBase: a.holdingAddress(base, trader), traderQuote: a.holdingAddress(SOL, trader), hookProgram: a.LAUNCH_PROGRAM };
    const args = { direction: 1 as const, amountIn: 1_000n, minAmountOut: 1n, inHookAccounts: 0, outHookAccounts: 0, hookData: new Uint8Array() };
    const plain = swap.swap(keys, args);
    holdToIdl('swap', 'swap', plain, 0);
    // The pool hook's signer is the DEX's for the launch.
    expect([keyAt(plain, 9), keyAt(plain, 10)]).toEqual([a.LAUNCH_PROGRAM.toBase58(), HOOK_SIGNERS.dexForLaunch]);
    // A pool without a hook: the DEX id in both slots.
    const hookless = swap.swap({ ...keys, hookProgram: null }, args);
    expect([keyAt(hookless, 9), keyAt(hookless, 10)]).toEqual([a.SWAP_PROGRAM.toBase58(), a.SWAP_PROGRAM.toBase58()]);
    // The base mint writable when asked (a burn), never otherwise.
    const burning = swap.swap({ ...keys, baseMintWritable: true }, args);
    holdToIdl('swap', 'swap', burning, 0, ['base_mint']);
    expect([burning.keys[3]!.isWritable, burning.keys[4]!.isWritable]).toEqual([true, false]);
    // Slices given whole: the counts follow, input then output then the pool's extras.
    const hook = kitTokenHook(base, null);
    const sliced = swap.swapWithHooks(keys, { direction: 0, amountIn: 5n, minAmountOut: 0n }, { inHook: hook, poolExtras: a.launchHookExtras(base, SOL) });
    holdToIdl('swap', 'swap', sliced, 8);
    // direction u8, amount_in u64, min_amount_out u64, in u8, out u8, hook data (u32 length).
    expect([sliced.data.length, sliced.data[8 + 1 + 16], sliced.data[8 + 1 + 16 + 1]]).toEqual([8 + 1 + 8 + 8 + 1 + 1 + 4, 4, 0]);
    expect(sliced.keys.slice(15, 19).map(metaOf)).toEqual(kitHookSlice(base, null).map(metaOf));

    const lkeys = { provider: trader, pool, baseMint: base, quoteMint: SOL, hookProgram: a.LAUNCH_PROGRAM };
    const s = swap.liquiditySlices({ baseHook: hook, poolExtras: a.launchHookExtras(base, SOL) });
    expect([s.baseHookAccounts, s.quoteHookAccounts, s.extras.length]).toEqual([4, 0, 8]);
    holdToIdl('swap', 'add_liquidity', swap.addLiquidity(lkeys, { baseDesired: 1n, quoteDesired: 1n, minLp: 1n, baseHookAccounts: 4, quoteHookAccounts: 0, hookData: new Uint8Array() }, s.extras), 8);
    holdToIdl('swap', 'remove_liquidity', swap.removeLiquidity(lkeys, { lpAmount: 1n, minBase: 0n, minQuote: 0n, baseHookAccounts: 4, quoteHookAccounts: 0, hookData: new Uint8Array() }, s.extras), 8);

    const createArgs = { lpFeeBps: 30, hookProgram: null, hookFlags: 0, virtualBase: 0n, virtualQuote: 0n, baseAmount: 10n, quoteAmount: 10n, baseHookAccounts: 0, quoteHookAccounts: 0, hookData: new Uint8Array() };
    const created = swap.createPool(trader, trader, k(), base, SOL, createArgs);
    holdToIdl('swap', 'create_pool', created, 0);
    expect([keyAt(created, 13), keyAt(created, 14), keyAt(created, 15)]).toEqual([a.SWAP_PROGRAM.toBase58(), a.SWAP_PROGRAM.toBase58(), a.SWAP_PROGRAM.toBase58()]);
    // A pool its hook creates: the hook's own authority signs as the caller, the DEX's signer for the hook is the hook signer.
    const curve = swap.createPool(trader, a.LAUNCH_HOOK_AUTHORITY, k(), base, SOL, { ...createArgs, hookProgram: a.LAUNCH_PROGRAM, hookFlags: 1_985 }, [], a.LAUNCH_HOOK_AUTHORITY);
    holdToIdl('swap', 'create_pool', curve, 0);
    expect(curve.keys[14]!.isSigner).toBe(true);
    expect(keyAt(curve, 15)).toBe(HOOK_SIGNERS.dexForLaunch);

    // Protocol fees: quote only; exactly the quote mint's slice remaining (none for bridged SOL).
    const collector = k();
    const collect = swap.collectProtocolFees(trader, pool, SOL, collector);
    holdToIdl('swap', 'collect_protocol_fees', collect, 0);
    expect(keyAt(collect, 5)).toBe(a.holdingAddress(SOL, collector).toBase58());
    expect([...collect.data.subarray(8)]).toEqual([0]);
    const taxed = swap.collectProtocolFees(trader, pool, base, collector, hook);
    holdToIdl('swap', 'collect_protocol_fees', taxed, 4);
    expect([...taxed.data.subarray(8)]).toEqual([4]);
    holdToIdl('swap', 'finalize_curve', swap.finalizeCurve(a.LAUNCH_HOOK_AUTHORITY, 254, pool, base, SOL, k()), 0);
    const cfg = { admin: trader, protocolFeeBps: 100, feeCollector: trader, treasury: trader, poolCreationFeeLamports: 0n, paused: false, launchProtocolShareBps: 2_500 };
    const initCfg = swap.initConfig(trader, cfg);
    holdToIdl('swap', 'init_config', initCfg, 0);
    holdToIdl('swap', 'set_config', swap.setConfig(trader, cfg), 0);
    // The launch share is the args' last field (u16): 2,500, a quarter of what a launch's rules collect.
    expect(initCfg.data.readUInt16LE(initCfg.data.length - 2)).toBe(2_500);
  });

  it('bridge: wrap and unwrap variants without the token hook signer', () => {
    const [user, underlying] = [k(), k()];
    const ata = a.associatedTokenAddress(user, underlying, a.SPL_TOKEN_PROGRAM);
    for (const [name, ix] of [
      ['wrap', bridge.wrap(user, underlying, a.SPL_TOKEN_PROGRAM, ata, 5n)],
      ['unwrap', bridge.unwrap(user, underlying, a.SPL_TOKEN_PROGRAM, ata, 5n)],
      ['wrap_sol', bridge.wrapSol(user, 5n)],
      ['unwrap_sol', bridge.unwrapSol(user, 5n)],
      ['unwrap_sol_above', bridge.unwrapSolAbove(user, 5n)],
      ['register', bridge.register(user, underlying, a.SPL_TOKEN_PROGRAM, { name: 'n', symbol: 's', uri: 'u' })],
      ['register_sol', bridge.registerSol(user)],
      ['init_config', bridge.initConfig(user, user, false)],
      ['set_config', bridge.setConfig(user, user, false)],
    ] as const) {
      holdToIdl('bridge', name, ix, 0);
      expect(ix.keys.some((m) => m.pubkey.toBase58() === 'BDDa1JTNkJSLAnwmUyqh43Pn4nsscKxmsYwUXdnN7gfb')).toBe(false);
    }
  });

  it('launch: create_launch with and without the kit accounts, graduate with the kit accounts, claim_creator_fees, the config with rule bounds', () => {
    const [creator, treasury] = [k(), k()];
    const mint = k();
    const args = { name: 'Launch EVRY', symbol: 'EVRY', uri: 'ipfs://x', creatorFeeBps: 50, virtualQuote: 28_125_000_000n };
    // Every rule: the six kit accounts, the reward vault among them.
    const every = launch.createLaunch(creator, mint, treasury, SOL, 30, { ...args, rules: EVERY_RULE });
    holdToIdl('launch', 'create_launch', every, 0);
    expect(every.keys.slice(23, 29).map((m) => m.pubkey.toBase58())).toEqual([a.KIT_PROGRAM, a.kitConfigAddress(mint), a.kitRegistryAddress(mint), a.rewardVaultAddress(mint, SOL), a.kitCallerAddress(mint), a.KIT_EVENT_AUTHORITY].map(String));
    // Max wallet only: a kit, but no reward vault (the launch id in its slot).
    const capped = launch.createLaunch(creator, mint, treasury, SOL, 30, { ...args, rules: { ...NO_LAUNCH_RULES, maxWalletBps: 200 } });
    holdToIdl('launch', 'create_launch', capped, 0);
    expect([keyAt(capped, 23), keyAt(capped, 26)]).toEqual([a.KIT_PROGRAM.toBase58(), a.LAUNCH_PROGRAM.toBase58()]);
    // No rules, or a burn alone: no kit, all six the launch id.
    for (const rules of [NO_LAUNCH_RULES, { ...NO_LAUNCH_RULES, burnBuyBps: 50, burnSellBps: 50 }]) {
      const plain = launch.createLaunch(creator, mint, treasury, SOL, 30, { ...args, rules });
      holdToIdl('launch', 'create_launch', plain, 0);
      expect(plain.keys.slice(23, 29).every((m) => m.pubkey.equals(a.LAUNCH_PROGRAM))).toBe(true);
    }
    // The signers of v2: the DEX's for the launch, the token program's for the kit.
    expect([keyAt(every, 15), keyAt(every, 16), keyAt(every, 20)]).toEqual([FIXED_ADDRESSES.launchHookAuthority, HOOK_SIGNERS.dexForLaunch, HOOK_SIGNERS.tokenForKit]);
    expect(keyAt(every, 8)).toBe(a.launchRegistryAddress(a.launchPoolAddress(mint, SOL, 30)).toBase58());

    // Graduate: the five kit accounts exactly with a kit; the vault slot the holder vault with rewards, else the kit's id.
    const cranker = k();
    const g15 = launch.graduate(cranker, mint, SOL, 30, 15);
    holdToIdl('launch', 'graduate', g15, 0);
    expect(g15.keys.slice(16, 21).map(metaOf)).toEqual([
      [a.KIT_PROGRAM.toBase58(), false, false],
      [a.kitConfigAddress(mint).toBase58(), false, true],
      [a.holderVaultAddress(mint, SOL).toBase58(), false, false],
      [a.kitCallerAddress(mint).toBase58(), false, false],
      [FIXED_ADDRESSES.kitEventAuthority, false, false],
    ]);
    const g2 = launch.graduate(cranker, mint, SOL, 30, 2);
    holdToIdl('launch', 'graduate', g2, 0);
    expect(keyAt(g2, 18)).toBe(a.KIT_PROGRAM.toBase58());
    const g0 = launch.graduate(cranker, mint, SOL, 30, 0);
    holdToIdl('launch', 'graduate', g0, 0);
    expect(g0.keys.slice(16, 21).every((m) => m.pubkey.equals(a.LAUNCH_PROGRAM))).toBe(true);

    holdToIdl('launch', 'claim_creator_fees', launch.claimCreatorFees(creator, mint, SOL), 0);
    const config = { admin: creator, treasury, quoteMint: SOL, launchFeeLamports: 10_000_000n, lpFeeBps: 30, maxCreatorFeeBps: 200, sniperWindowSecs: 30, sniperStartBps: 8_000, curveBps: 7_500, supply: 10n ** 15n, decimals: 6, minVirtualQuote: 10n ** 9n, maxVirtualQuote: 10n ** 13n, paused: false, ruleBounds: RULE_BOUNDS };
    const init = launch.initConfig(creator, config);
    holdToIdl('launch', 'init_config', init, 0);
    holdToIdl('launch', 'set_config', launch.setConfig(creator, config), 0);
    // The rule bounds are the args' last field: u16 × 5 then u32 × 3.
    const tail = init.data.subarray(init.data.length - 22);
    expect([tail.readUInt16LE(0), tail.readUInt16LE(2), tail.readUInt16LE(4), tail.readUInt16LE(6), tail.readUInt16LE(8), tail.readUInt32LE(10), tail.readUInt32LE(14), tail.readUInt32LE(18)]).toEqual([200, 100, 300, 100, 500, 90 * DAY, 300, 7 * DAY]);
    // Without a config the optional slot after the kit accounts (index 29) is the launch's id.
    expect(keyAt(every, 29)).toBe(a.LAUNCH_PROGRAM.toBase58());
  });

  it('launch: create_config with and without a hook, create_launch from a config, and with a custom hook its accounts as remaining accounts (§5.7, §5.8)', () => {
    const [creator, treasury, configKey, hook, collector] = [k(), k(), k(), k(), k()];
    const mint = k();
    const rules = { ...NO_LAUNCH_RULES, burnBuyBps: 25, burnSellBps: 25 };
    // A kit config: no hook program passed (the launch's id in the optional slot).
    const kitCfg = launch.createConfig(creator, configKey, { rules: EVERY_RULE, creatorFeeBps: 50, customHook: null, customHookFlags: 0, label: 'every rule' });
    holdToIdl('launch', 'create_config', kitCfg, 0);
    expect([keyAt(kitCfg, 1), keyAt(kitCfg, 2), kitCfg.keys[2]!.isSigner, keyAt(kitCfg, 3)]).toEqual([a.LAUNCH_CONFIG.toBase58(), configKey.toBase58(), true, a.LAUNCH_PROGRAM.toBase58()]);
    // A hook config names the program in that slot; the args end with the label.
    const hookCfg = launch.createConfig(creator, configKey, { rules, creatorFeeBps: 100, customHook: hook, customHookFlags: TAX_HOOK_FLAGS, label: 'taxed' });
    holdToIdl('launch', 'create_config', hookCfg, 0);
    expect(keyAt(hookCfg, 3)).toBe(hook.toBase58());
    expect(hookCfg.data.subarray(hookCfg.data.length - 5).toString('utf8')).toBe('taxed');
    expect(hookCfg.data.readUInt32LE(hookCfg.data.length - 9)).toBe(5);
    const made = buildCreateConfig(creator, { rules, creatorFeeBps: 100, customHook: hook, customHookFlags: TAX_HOOK_FLAGS, label: 'taxed' });
    expect([made.address.equals(made.keypair.publicKey), made.instruction.keys[2]!.pubkey.equals(made.address), made.instruction.keys[2]!.isSigner]).toEqual([true, true, true]);

    // From a config with kit rules: the kit accounts as inline, the config in the slot after them.
    const args = { name: 'Launch', symbol: 'L', uri: 'ipfs://x', creatorFeeBps: 50, virtualQuote: 28_125_000_000n };
    const fromConfig = launch.createLaunch(creator, mint, treasury, SOL, 30, { ...args, rules: EVERY_RULE }, { launchConfig: configKey });
    holdToIdl('launch', 'create_launch', fromConfig, 0);
    expect([keyAt(fromConfig, 23), keyAt(fromConfig, 29)]).toEqual([a.KIT_PROGRAM.toBase58(), configKey.toBase58()]);

    // With a custom hook: no kit accounts, the config, then [hook, the token program's signer for it, its registry for the mint, ...extras].
    const accounts = taxHook.accounts(mint, collector);
    const own = launch.createLaunch(creator, mint, treasury, SOL, 30, { ...args, creatorFeeBps: 100, rules }, { launchConfig: configKey, customHook: accounts });
    holdToIdl('launch', 'create_launch', own, 5);
    expect(own.keys.slice(23, 29).every((m) => m.pubkey.equals(a.LAUNCH_PROGRAM))).toBe(true);
    expect(own.keys.slice(32).map(metaOf)).toEqual([
      [a.TAX_HOOK_PROGRAM.toBase58(), false, false],
      [HOOK_SIGNERS.tokenForTaxHook, false, false],
      [a.registryAddress(a.TAX_HOOK_PROGRAM, mint).toBase58(), false, false],
      [a.taxConfigAddress(mint).toBase58(), false, true],
      [a.holdingAddress(mint, collector).toBase58(), false, true],
    ]);
    expect(own.keys.slice(32).map(metaOf)).toEqual(customHookLaunchAccounts(accounts, mint).map(metaOf));
    // One token hook per mint: kit rules and a custom hook never share a launch.
    expect(() => launch.createLaunch(creator, mint, treasury, SOL, 30, { ...args, rules: EVERY_RULE }, { customHook: accounts })).toThrow(/one token hook per mint/);

    // Graduation with the hook: its slice [hook, signer, extras] after the 23 accounts (no kit accounts).
    const grad = launch.graduate(k(), mint, SOL, 30, 0, accounts);
    holdToIdl('launch', 'graduate', grad, 4);
    expect(grad.keys.slice(23).map(metaOf)).toEqual(customHookSlice(accounts).map(metaOf));

    // The swap carries the same slice on the base side, where a kit launch carries the kit's.
    const keys = launchKeys(mint, SOL, 30, rules, accounts);
    const buy = launch.swap(keys, creator, creator, 1, 1_000_000_000n, 5n);
    holdToIdl('swap', 'swap', buy, 8, ['base_mint']);
    expect([buy.data[25], buy.data[26]]).toEqual([0, 4]);
    expect(buy.keys.slice(15, 19).map(metaOf)).toEqual(customHookSlice(accounts).map(metaOf));
    const sell = launch.swap(keys, creator, creator, 0, 5n, 0n);
    expect([sell.data[25], sell.data[26]]).toEqual([4, 0]);
    // The keys of a decoded launch with a hook need the hook's accounts.
    const decoded = { mint, quoteMint: SOL, lpFeeBps: 30, rules, customHook: a.TAX_HOOK_PROGRAM };
    expect(() => launchKeysOf(decoded)).toThrow(/resolve its accounts/);
    expect(() => launchKeysOf(decoded, { program: k(), extras: [] })).toThrow(/another program/);
    expect(launchKeysOf(decoded, accounts).customHook).toBe(accounts);
    expect(launchKeysOf({ ...decoded, customHook: null }).customHook).toBeNull();
  });

  it('half_life: prepare, light and stoke match the IDL, and its registry resolves to `halfLife.accounts`', () => {
    const [payer, mint] = [k(), k()];
    const prepare = halfLife.prepare(payer, mint);
    holdToIdl('halfLife', 'prepare', prepare, 0);
    expect(prepare.keys.slice(1, 4).map((m) => m.pubkey.toBase58())).toEqual([mint, a.halfLifeStateAddress(mint), a.registryAddress(a.HALF_LIFE_PROGRAM, mint)].map(String));
    holdToIdl('halfLife', 'light', halfLife.light(payer, mint), 0);
    const stoke = halfLife.stoke(mint);
    holdToIdl('halfLife', 'stoke', stoke, 0);
    expect(stoke.keys.map((m) => m.pubkey.toBase58())).toContain(HALF_LIFE.tokenHookSigner);
    // The registry `prepare` writes (programs/half_life `prepare`): the state, the furnace holding, the launch account.
    const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
    const list = {
      version: 1,
      accounts: [
        { writable: true, source: { kind: 'pda' as const, program: a.HALF_LIFE_PROGRAM, seeds: [{ kind: 'literal' as const, bytes: enc('half-life') }, { kind: 'account' as const, index: 1 }] } },
        { writable: true, source: { kind: 'key' as const, key: a.halfLifeFurnaceHolding(mint) } },
        { writable: false, source: { kind: 'pda' as const, program: a.LAUNCH_PROGRAM, seeds: [{ kind: 'literal' as const, bytes: enc('launch') }, { kind: 'account' as const, index: 1 }] } },
      ],
    };
    expect(resolveCustomHookAccounts(a.HALF_LIFE_PROGRAM, list, mint).extras.map(metaOf)).toEqual(halfLife.accounts(mint).extras.map(metaOf));
    // The age record: "HL", layout 1, the arrival time.
    const data = new Uint8Array(64);
    data.set([0x48, 0x4c, 1]);
    Buffer.from(data.buffer).writeBigInt64LE(1_791_419_498n, 3);
    expect(halfLifeSince(data)).toBe(1_791_419_498);
    expect(halfLifeSince(new Uint8Array(64))).toBeNull();
  });

  it('tax_hook: prepare for a mint that does not exist yet, and install on one that does', () => {
    const [authority, mint, collector] = [k(), k(), k()];
    const prepare = taxHook.prepare(authority, mint, collector, 100, 0);
    holdToIdl('taxHook', 'prepare', prepare, 0);
    expect(prepare.keys.slice(1, 5).map((m) => m.pubkey.toBase58())).toEqual([mint, collector, a.taxConfigAddress(mint), a.registryAddress(a.TAX_HOOK_PROGRAM, mint)].map(String));
    expect([prepare.data.readUInt16LE(8), prepare.data.readUInt16LE(10)]).toEqual([100, 0]);
    holdToIdl('taxHook', 'install', taxHook.install(authority, mint, a.holdingAddress(mint, collector), 100, 0), 0);
    // The registry `prepare` writes resolves to the hook's two accounts, as `taxHook.accounts` lists them without reading it.
    const list = { version: 1, accounts: [{ writable: true, source: { kind: 'key' as const, key: a.taxConfigAddress(mint) } }, { writable: true, source: { kind: 'key' as const, key: a.holdingAddress(mint, collector) } }] };
    expect(resolveCustomHookAccounts(a.TAX_HOOK_PROGRAM, list, mint).extras.map(metaOf)).toEqual(taxHook.accounts(mint, collector).extras.map(metaOf));
    // A registry that depends on the transfer's parties cannot serve a launch.
    const perHolder = { version: 1, accounts: [{ writable: true, source: { kind: 'pda' as const, program: a.TAX_HOOK_PROGRAM, seeds: [{ kind: 'sourceOwner' as const }] } }] };
    expect(() => resolveCustomHookAccounts(a.TAX_HOOK_PROGRAM, perHolder, mint)).toThrow(/who sends or receives/);
  });

  it('checks a config as create_config does (inspect.ts): the bounds, the creator fee, the label, the hook’s rules', () => {
    const launchConfig = { ruleBounds: RULE_BOUNDS, maxCreatorFeeBps: 200 };
    const deployed = { executable: true };
    const base = { rules: NO_LAUNCH_RULES, creatorFeeBps: 100, customHook: null, customHookFlags: 0, label: 'plain' };
    expect(configProblems(base, launchConfig, null)).toEqual([]);
    expect(configProblems({ ...base, label: 'x'.repeat(33) }, launchConfig, null)).toEqual(['The label is at most 32 bytes.']);
    expect(configProblems({ ...base, creatorFeeBps: 300 }, launchConfig, null)).toEqual(['The creator fee can be at most 2%.']);
    expect(configProblems({ ...base, rules: { ...NO_LAUNCH_RULES, holderFeeBuyBps: 300 } }, launchConfig, null)).toEqual(['Holder rewards can be at most 2% per side.']);
    expect(configProblems({ ...base, customHookFlags: 1 }, launchConfig, null)).toEqual(['Hook flags were set without a hook.']);
    const hook = k();
    expect(configProblems({ ...base, customHook: hook, customHookFlags: TAX_HOOK_FLAGS }, launchConfig, deployed)).toEqual([]);
    expect(configProblems({ ...base, customHook: hook, customHookFlags: TAX_HOOK_FLAGS }, launchConfig, null)).toEqual(['The hook program is not deployed on this cluster.']);
    expect(configProblems({ ...base, customHook: hook, customHookFlags: 0 }, launchConfig, deployed)).toEqual(['The hook’s flags must name at least one callback it runs on, with no unknown bit.']);
    expect(configProblems({ ...base, customHook: hook, customHookFlags: 256 }, launchConfig, deployed)).toHaveLength(1);
    expect(configProblems({ ...base, customHook: hook, customHookFlags: 1, rules: EVERY_RULE }, launchConfig, deployed)).toEqual(['A config with a custom hook can’t have holder rewards, max wallet or the locks: one token hook per mint. Burn and the creator fee are fine.']);
    for (const program of PROTOCOL_PROGRAMS) expect(configProblems({ ...base, customHook: program, customHookFlags: 1 }, launchConfig, deployed)).toEqual(['The hook must be a program of your own, not one of Bordrless’s.']);
    // A registry longer than a launch can carry in one transaction (transactions.test.ts measures the bound) is a problem before the hook is prepared for a mint.
    const extra = { writable: true, source: { kind: 'key' as const, key: k() } };
    expect(registryLengthProblem({ accounts: Array.from({ length: MAX_CUSTOM_HOOK_EXTRAS }, () => extra) })).toBeNull();
    expect(registryLengthProblem({ accounts: Array.from({ length: MAX_CUSTOM_HOOK_EXTRAS + 1 }, () => extra) })).toBe(`The hook’s registry lists ${MAX_CUSTOM_HOOK_EXTRAS + 1} accounts; a launch fits at most ${MAX_CUSTOM_HOOK_EXTRAS} in one transaction.`);
    // The program's upgrade authority, from a ProgramData account: the owner's key, or none once final.
    const owner = k();
    const data = Buffer.alloc(45);
    data.writeUInt32LE(3, 0);
    data[12] = 1;
    owner.toBuffer().copy(data, 13);
    const programAccount = { executable: true, owner: a.BPF_LOADER_UPGRADEABLE, data: Buffer.concat([Buffer.from([2, 0, 0, 0]), a.programDataAddress(hook).toBuffer()]), lamports: 1, rentEpoch: 0 };
    expect(programUpgradeInfoOf(programAccount, { ...programAccount, data })).toMatchObject({ executable: true, upgradeAuthority: owner, upgradeable: true });
    data[12] = 0;
    expect(programUpgradeInfoOf(programAccount, { ...programAccount, data })).toMatchObject({ executable: true, upgradeAuthority: null, upgradeable: false });
    expect(programUpgradeInfoOf(null, null)).toEqual({ executable: false, upgradeAuthority: null, upgradeable: null });
  });

  it('kit: claim, share, init and graduate', () => {
    const [owner, mint] = [k(), k()];
    const claim = kit.claim(owner, mint, SOL);
    holdToIdl('kit', 'claim', claim, 0);
    expect(claim.keys.slice(1, 8).map((m) => m.pubkey.toBase58())).toEqual([a.kitConfigAddress(mint), mint, a.holdingAddress(mint, owner), SOL, a.rewardVaultAddress(mint, SOL), a.holdingAddress(SOL, owner), a.KIT_HOOK_AUTHORITY].map(String));
    const share = kit.share(owner, mint, a.holdingAddress(SOL, owner), SOL, 1_000_000n);
    holdToIdl('kit', 'share', share, 0);
    expect(share.data.readBigUInt64LE(8)).toBe(1_000_000n);
    const launchKey = a.launchAddress(mint);
    const caller = a.kitCallerPda(mint);
    const initArgs = { launch: launchKey, pool: a.launchPoolAddress(mint, SOL, 30), creator: owner, rewardMint: SOL, modules: 15, maxWalletBps: 500, creatorUnlockAt: 1_800_000_000 + 30 * DAY, earlyWindowEnd: 1_800_000_060, earlyUnlockAt: 1_800_003_600, kitCallerBump: caller.bump };
    const init = kit.init(caller.address, owner, mint, initArgs);
    holdToIdl('kit', 'init', init, 0);
    expect([keyAt(init, 3), keyAt(init, 7)]).toEqual([a.launchReserveAddress(mint).toBase58(), a.rewardVaultAddress(mint, SOL).toBase58()]);
    const noRewards = kit.init(caller.address, owner, mint, { ...initArgs, modules: 2 });
    holdToIdl('kit', 'init', noRewards, 0);
    expect(keyAt(noRewards, 7)).toBe(a.KIT_PROGRAM.toBase58());
    holdToIdl('kit', 'graduate', kit.graduate(caller.address, mint), 0);
  });
});

describe('the launch-pool swap recipe (programs-summary §2.6)', () => {
  const trader = k();
  const recipient = k();
  const mint = k();

  it('a buy: the trader pays from its quote holding, the recipient receives, the kit slice on the output side, the base mint writable with a burn', () => {
    const keys = launchKeys(mint, SOL, 30, EVERY_RULE);
    expect([keys.modules, keys.burns]).toEqual([15, true]);
    const buy = launch.swap(keys, trader, recipient, 1, 1_000_000_000n, 5n);
    holdToIdl('swap', 'swap', buy, 8, ['base_mint']);
    expect([keyAt(buy, 2), keyAt(buy, 7), keyAt(buy, 8)]).toEqual([a.launchPoolAddress(mint, SOL, 30), a.holdingAddress(mint, recipient), a.holdingAddress(SOL, trader)].map(String));
    expect([buy.keys[3]!.isWritable, buy.keys[4]!.isWritable]).toEqual([true, false]);
    expect([buy.data[8], buy.data.readBigUInt64LE(9), buy.data.readBigUInt64LE(17), buy.data[25], buy.data[26], buy.data.readUInt32LE(27)]).toEqual([1, 1_000_000_000n, 5n, 0, 4, 0]);
    expect(buy.keys.slice(15).map(metaOf)).toEqual([...kitHookSlice(mint, a.rewardVaultAddress(mint, SOL)), ...a.launchHookExtras(mint, SOL)].map(metaOf));
  });

  it('a sell: the kit slice on the input side, the recipient receives the quote', () => {
    const sell = launch.swap(launchKeys(mint, SOL, 30, EVERY_RULE), trader, recipient, 0, 5n, 0n);
    expect([keyAt(sell, 7), keyAt(sell, 8)]).toEqual([a.holdingAddress(mint, trader), a.holdingAddress(SOL, recipient)].map(String));
    expect([sell.data[8], sell.data[25], sell.data[26]]).toEqual([0, 4, 0]);
  });

  it('without kit modules there is no slice; without a burn the base mint stays read-only; the pool extras are passed whatever the rules', () => {
    const plain = launch.swap(launchKeys(mint, SOL, 30, NO_LAUNCH_RULES), trader, trader, 1, 5n, 0n);
    holdToIdl('swap', 'swap', plain, 4);
    expect([plain.keys[3]!.isWritable, plain.data[25], plain.data[26]]).toEqual([false, 0, 0]);
    expect(plain.keys.slice(15).map(metaOf)).toEqual(a.launchHookExtras(mint, SOL).map(metaOf));
    const burnOnly = launch.swap(launchKeys(mint, SOL, 30, { ...NO_LAUNCH_RULES, burnSellBps: 25 }), trader, trader, 0, 5n, 0n);
    holdToIdl('swap', 'swap', burnOnly, 4, ['base_mint']);
    expect(burnOnly.keys[3]!.isWritable).toBe(true);
    // Max wallet alone: the kit slice with the kit's id for the vault.
    const capped = launch.swap(launchKeys(mint, SOL, 30, { ...NO_LAUNCH_RULES, maxWalletBps: 200 }), trader, trader, 1, 5n, 0n);
    holdToIdl('swap', 'swap', capped, 8);
    expect(capped.keys.slice(15, 19).map(metaOf)).toEqual(kitHookSlice(mint, null).map(metaOf));
    expect(tokenHookSlice(kitTokenHook(mint, null)).map(metaOf)).toEqual(capped.keys.slice(15, 19).map(metaOf));
  });
});
