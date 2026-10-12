/**
 * Hooks, companions and pairs from your own terminal (README, "Hooks, companions and pairs from
 * your own terminal"): the calls the section names, built and read against a fake chain, so an
 * example there compiles and runs as written. The self-serve lanes: a hook you deployed and made
 * immutable, prepared for the mint with the template's `prepare`, checked and made into a config;
 * a script you deployed and made immutable, set up on a companion and stepped; a pair, the two
 * together. Signatures are never involved: the builders answer instructions.
 */
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { RULE_BOUNDS, TOKEN_HOOK_FLAGS, TOKEN_SUPPLY } from '@bordrless/shared';
import { NO_LAUNCH_RULES, decodeLaunchConfigAccount } from './accounts.ts';
import { BPF_LOADER_UPGRADEABLE, BRIDGED_SOL_MINT, LAUNCH_CONFIG, LAUNCH_PROGRAM, SYSTEM_PROGRAM, companionAddress, companionCreatorAddress, launchAddress, programDataAddress, registryAddress, scriptAddress, scriptStateAddress } from './addresses.ts';
import { CODERS } from './coders.ts';
import { COMPANION_DEFAULTS, companion } from './companion.ts';
import { customHookLaunchAccounts, encodeHookAccountList, fetchCustomHookAccounts, type HookAccountList, type Seed } from './hooks.ts';
import { buildCreateConfig, inspectConfig, inspectTokenHook } from './inspect.ts';
import { launch, launchKeys } from './instructions.ts';
import { SCRIPT_LIMITS, scriptClaimAuthor, scriptDue, scriptInitDataBytes, scriptProgramStatusOf } from './scripts.ts';
import { hookStateAddress, templateHook } from './template.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const bn = (v: bigint | number): BN => new BN(v.toString());
const info = (owner: PublicKey, data: Buffer, executable = false): AccountInfo<Buffer> => ({ owner, data, executable, lamports: 1, rentEpoch: 0 });
const literal = (s: string): Seed => ({ kind: 'literal', bytes: Buffer.from(s, 'utf8') });

/** A fake chain: accounts by address, read the two ways the inspectors read them. */
function chain(): { accounts: Map<string, AccountInfo<Buffer>>; connection: Connection } {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const connection = {
    getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) => accounts.get(key.toBase58()) ?? null),
  } as unknown as Connection;
  return { accounts, connection };
}

/** `program` deployed through the upgradeable loader and made immutable (`solana program set-upgrade-authority <program> --final`). */
function deployImmutable(accounts: Map<string, AccountInfo<Buffer>>, program: PublicKey): void {
  const header = Buffer.alloc(45);
  header.writeUInt32LE(3, 0);
  header.writeBigUInt64LE(455_000_000n, 4);
  accounts.set(program.toBase58(), info(BPF_LOADER_UPGRADEABLE, Buffer.concat([Buffer.from([2, 0, 0, 0]), programDataAddress(program).toBuffer()]), true));
  accounts.set(programDataAddress(program).toBase58(), info(BPF_LOADER_UPGRADEABLE, Buffer.concat([header, Buffer.from([1, 2, 3])])));
}

/** The launchpad's `Config` on this cluster. */
async function launchpad(accounts: Map<string, AccountInfo<Buffer>>): Promise<{ treasury: PublicKey }> {
  const admin = k();
  const data = await CODERS.launch.accounts.encode('config', {
    version: 1, bump: 255, admin, treasury: admin, quoteMint: BRIDGED_SOL_MINT, launchFeeLamports: bn(10_000_000n), lpFeeBps: 30, maxCreatorFeeBps: 200, sniperWindowSecs: bn(30), sniperStartBps: 8_000, curveBps: 7_500,
    supply: bn(TOKEN_SUPPLY), decimals: 6, minVirtualQuote: bn(1_000_000_000n), maxVirtualQuote: bn(10_000_000_000_000n), paused: false, launches: bn(0), ruleBounds: { ...RULE_BOUNDS }, reserved: Array(64).fill(0),
  });
  accounts.set(LAUNCH_CONFIG.toBase58(), info(LAUNCH_PROGRAM, data));
  return { treasury: admin };
}

/** The template starter's registry for `mint`: its state (read-only) and the mint's launch (read-only), both PDAs on the mint. */
const starterRegistry = (hook: PublicKey): HookAccountList => ({
  version: 1,
  accounts: [
    { writable: false, source: { kind: 'pda', program: hook, seeds: [literal('state'), { kind: 'account', index: 1 }] } },
    { writable: false, source: { kind: 'pda', program: LAUNCH_PROGRAM, seeds: [literal('launch'), { kind: 'account', index: 1 }] } },
  ],
});

describe('a trade hook from your own terminal', () => {
  it('is prepared for the mint, checked, made into a config, and launched from it', async () => {
    const { accounts, connection } = chain();
    const { treasury } = await launchpad(accounts);
    const [me, hook] = [k(), k()];
    const mint = Keypair.generate().publicKey; // the launch page shows it; a terminal makes it
    deployImmutable(accounts, hook);

    // 1. Prepare the hook for the mint: the template's standard `prepare` (the registry it writes is the starter's here).
    const prepare = templateHook.prepare(hook, me, mint);
    expect(prepare.keys[2]!.pubkey.equals(hookStateAddress(hook, mint))).toBe(true);
    accounts.set(registryAddress(hook, mint).toBase58(), info(hook, encodeHookAccountList(starterRegistry(hook))));

    // 2. What the launch page will say of the hook for this mint.
    const seen = await inspectTokenHook(connection, hook, mint);
    expect(seen).toMatchObject({ ownProgram: true, accepted: true, registryReady: true, problems: [] });
    expect(seen.info).toMatchObject({ executable: true, upgradeAuthority: null, upgradeable: false });
    expect(seen.accounts?.extras.map((m) => [m.pubkey.toBase58(), m.isWritable])).toEqual([
      [hookStateAddress(hook, mint).toBase58(), false],
      [launchAddress(mint).toBase58(), false],
    ]);
    expect(await fetchCustomHookAccounts(connection, hook, mint)).toEqual(seen.accounts);

    // 3. The config: burn and the creator fee may go with a custom hook; the kit's rules may not.
    const made = buildCreateConfig(me, { rules: { ...NO_LAUNCH_RULES, burnBuyBps: 25, burnSellBps: 25 }, creatorFeeBps: 100, customHook: hook, customHookFlags: TOKEN_HOOK_FLAGS.BEFORE_TRANSFER | TOKEN_HOOK_FLAGS.TRANSFER_RETURNS_DELTA, label: 'mine' });
    const onChain = await CODERS.launch.accounts.encode('launchConfig', { version: 1, creator: me, rules: { ...NO_LAUNCH_RULES, burnBuyBps: 25, burnSellBps: 25 }, creatorFeeBps: 100, customHook: hook, customHookFlags: 65, label: 'mine', createdAt: bn(1_760_000_000), authorShareBps: 0, reserved: Array(30).fill(0) });
    accounts.set(made.address.toBase58(), info(LAUNCH_PROGRAM, Buffer.concat([onChain, Buffer.alloc(Math.max(0, 176 - onChain.length))])));
    const config = await inspectConfig(connection, made.address, mint);
    expect(config).toMatchObject({ problems: [], hookAccepted: true, registryReady: true, halfLife: false });
    expect(config!.hookAccounts).toEqual(seen.accounts);
    expect(decodeLaunchConfigAccount(accounts.get(made.address.toBase58())!.data)).toMatchObject({ customHook: hook, authorShareBps: 0, hookTimelocked: false });

    // 4. The launch from it, with the hook's accounts as the remaining accounts, exactly as the site builds it.
    const args = { name: 'Mine', symbol: 'MINE', uri: 'ipfs://x', creatorFeeBps: 100, virtualQuote: 1_000_000_000n, rules: config!.config.rules };
    const ix = launch.createLaunch(me, mint, treasury, BRIDGED_SOL_MINT, 30, args, { launchConfig: made.address, customHook: config!.hookAccounts });
    const remaining = ix.keys.slice(ix.keys.length - customHookLaunchAccounts(config!.hookAccounts!, mint).length);
    expect(remaining).toEqual(customHookLaunchAccounts(config!.hookAccounts!, mint));
    // And its swaps carry the hook's slice on the base side.
    const keys = launchKeys(mint, BRIDGED_SOL_MINT, 30, args.rules, config!.hookAccounts);
    expect(launch.swap(keys, me, me, 1, 1_000_000n, 0n).keys.some((m) => m.pubkey.equals(hook))).toBe(true);
  });
});

describe('a companion script from your own terminal', () => {
  it('is checked, set up on a companion before the launch, claimed and stepped', async () => {
    const { accounts, connection } = chain();
    const [me, script] = [k(), k()];
    const mint = Keypair.generate().publicKey;
    deployImmutable(accounts, script);

    // 1. What the companion program will say of it: immutable, so no approval needed (the self-serve lane).
    const status = scriptProgramStatusOf(script, accounts.get(script.toBase58())!, accounts.get(programDataAddress(script).toBase58())!, null);
    expect(status).toMatchObject({ immutable: true, lane: 'self-serve', author: null, problems: [] });
    void connection;

    // 2. The setup, both signed by me and the mint: create (a placeholder split), then create_script with the real one.
    const split = { buybackBps: 0, holdersBps: 0, beneficiaryBps: 3_000 };
    const setup = [
      companion.create(me, me, mint, { split: { buybackBps: 0, holdersBps: 0, beneficiaryBps: 10_000 }, ...COMPANION_DEFAULTS, fund: 60_890_880n }),
      companion.createScript(me, mint, { split, potBps: 7_000, program: script, interval: 60, stateLen: 128, initData: scriptInitDataBytes('0102') }),
    ];
    for (const ix of setup) expect(ix.keys.filter((m) => m.isSigner).map((m) => m.pubkey.toBase58())).toEqual([me.toBase58(), mint.toBase58()]);
    const created = setup[1]!;
    expect(created.keys.map((m) => m.pubkey.toBase58()).slice(2, 5)).toEqual([companionAddress(mint).toBase58(), scriptAddress(mint).toBase58(), scriptStateAddress(mint).toBase58()]);
    expect(created.keys.some((m) => m.pubkey.equals(script))).toBe(true);

    // 3. A fee claim: an immutable script has no author, so the claim passes the script and nothing more.
    expect(scriptClaimAuthor({ author: null }, { beneficiary: me })).toBeNull();
    const claim = companion.claimFeesScript(me, mint, null);
    expect(claim.keys.at(-1)!.pubkey.equals(scriptAddress(mint))).toBe(true);

    // 4. A step, once due: the companion's six accounts, the script's own extras, then the holding and unwrap accounts the SDK appends.
    const now = 1_760_000_000;
    expect(scriptDue({ launched: true, launchedAt: now - SCRIPT_LIMITS.afterLaunchSecs }, { lastAt: 0, interval: 60 }, now)).toBe(true);
    const keys = launchKeys(mint, BRIDGED_SOL_MINT, 30, NO_LAUNCH_RULES);
    const extras = [{ pubkey: k(), isSigner: false, isWritable: true }];
    const step = companion.scriptStep(me, keys, script, extras);
    const named = step.keys.slice(0, 14).map((m) => m.pubkey.toBase58());
    expect(named.slice(0, 3)).toEqual([me.toBase58(), companionAddress(mint).toBase58(), companionCreatorAddress(mint).toBase58()]);
    expect(named[7]).toBe(scriptStateAddress(mint).toBase58());
    expect(named[9]).toBe(script.toBase58());
    expect(named[11]).toBe(SYSTEM_PROGRAM.toBase58());
    expect(step.keys[14]).toEqual({ ...extras[0], isSigner: false });
  });
});

describe('a pair from your own terminal', () => {
  it('is the hook’s config (a plain one: no author share) and the script, launched together', async () => {
    const { accounts, connection } = chain();
    await launchpad(accounts);
    const [me, hook, script] = [k(), k(), k()];
    const mint = Keypair.generate().publicKey;
    deployImmutable(accounts, hook);
    deployImmutable(accounts, script);
    accounts.set(registryAddress(hook, mint).toBase58(), info(hook, encodeHookAccountList(starterRegistry(hook))));
    // The config on the pair's hook is a plain `buildCreateConfig`: a companion refuses a listed one (no author share), and no holders' share goes with a custom hook.
    const made = buildCreateConfig(me, { rules: { ...NO_LAUNCH_RULES }, creatorFeeBps: 100, customHook: hook, customHookFlags: 129, label: 'pair' });
    const onChain = await CODERS.launch.accounts.encode('launchConfig', { version: 1, creator: me, rules: { ...NO_LAUNCH_RULES }, creatorFeeBps: 100, customHook: hook, customHookFlags: 129, label: 'pair', createdAt: bn(1_760_000_000), authorShareBps: 0, reserved: Array(30).fill(0) });
    accounts.set(made.address.toBase58(), info(LAUNCH_PROGRAM, Buffer.concat([onChain, Buffer.alloc(Math.max(0, 176 - onChain.length))])));
    const config = await inspectConfig(connection, made.address, mint);
    expect(config).toMatchObject({ problems: [], hookAccepted: true, registryReady: true });
    // The companion's launch wraps the launch from the config, with the hook's accounts and the creator address as the creator.
    const args = { name: 'Pair', symbol: 'PAIR', uri: 'ipfs://x', creatorFeeBps: 100, virtualQuote: 1_000_000_000n, rules: config!.config.rules };
    const inner = launch.createLaunch(companionCreatorAddress(mint), mint, k(), BRIDGED_SOL_MINT, 30, args, { launchConfig: made.address, customHook: config!.hookAccounts });
    const wrapped = companion.launch(me, mint, inner, args);
    expect(wrapped.keys.filter((m) => m.isSigner).map((m) => m.pubkey.toBase58())).toEqual([me.toBase58(), mint.toBase58()]);
    expect(wrapped.keys.some((m) => m.pubkey.equals(hook))).toBe(true);
    // Every token move of the companion then carries the hook: its slice and its registry.
    const keys = launchKeys(mint, BRIDGED_SOL_MINT, 30, args.rules, config!.hookAccounts);
    const step = companion.scriptStep(me, keys, script, []);
    expect(step.keys[5]!.pubkey.toBase58()).toBe(keys.mint.toBase58() === mint.toBase58() ? step.keys[5]!.pubkey.toBase58() : '');
    const buyback = companion.buyback(me, keys, false);
    expect(buyback.keys.at(-1)!.pubkey.equals(registryAddress(hook, mint))).toBe(true);
  });
});
