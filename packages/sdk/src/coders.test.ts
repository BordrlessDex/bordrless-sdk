/**
 * The v2 account layouts and events through the IDL coders, and errors explained by the program that
 * failed. Accounts are encoded with the coder and read back through the typed decoders; the sizes and
 * offsets are programs-summary §6's.
 */
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodeKitHookData, encodeKitHookData, kitMintFlags, rewardsClaimable, type LaunchRules } from '@bordrless/shared';
import * as a from './addresses.ts';
import { FEE_MODEL_FLAT, FEE_MODEL_SHARE, HOLDING_SIZE, KIT_CONFIG_SIZE, LAUNCH_CONFIG_ACCOUNT_SIZE, apiLaunchRules, decodeHolding, decodeKitConfig, decodeLaunch, decodeLaunchConfig, decodeLaunchConfigAccount, decodeMint, decodePool, decodeSwapConfig, hasCustomHook, isVerifiedKitToken, kitExcludes, kitHookDataOf, kitModulesOf, kitRewardsOf, launchConfigOf, launchRulesFromInput, launchRulesInputOf, poolSharesCuts } from './accounts.ts';
import { CODERS, IDL, type ProgramName } from './coders.ts';
import { PROGRAM_ERRORS, explainFailure, explainProgramError, failedProgram } from './errors.ts';
import { EVENT_IX_TAG, GAME_EVENT_PROGRAMS, INDEXED_EVENT_PROGRAMS, eventsOf, launchSwapCuts, typedEvent, type DecodedEvent, type LaunchConfigCreatedEvent, type SwappedEvent } from './events.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const SOL = a.BRIDGED_SOL_MINT;
const bn = (v: bigint | number): BN => new BN(v.toString());
const rulesRaw = { holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 50, burnSellBps: 50, maxWalletBps: 500, creatorLockSecs: 30 * 86_400, earlyWindowSecs: 60, earlyLockSecs: 3_600 };

async function encodeAccount(program: ProgramName, name: string, value: Record<string, unknown>): Promise<Buffer> {
  return CODERS[program].accounts.encode(name, value);
}

/** An event as the program emits it: a self-CPI of `tag ‖ discriminator ‖ Borsh`, with the event authority as its only account. */
function emitted(program: ProgramName, programId: PublicKey, name: string, value: Record<string, unknown>): { keys: string[]; inner: { programIdIndex: number; accounts: number[]; data: string }[] } {
  const idl = (IDL[program] as unknown as { events: { name: string; discriminator: number[] }[] }).events;
  const disc = idl.find((e) => e.name === name.charAt(0).toUpperCase() + name.slice(1))!.discriminator;
  const body = CODERS[program].types.encode(name, value);
  const data = Buffer.concat([EVENT_IX_TAG, Buffer.from(disc), body]).toString('base64');
  return { keys: [programId.toBase58(), a.eventAuthority(programId).toBase58()], inner: [{ programIdIndex: 0, accounts: [1], data }] };
}

function decodeOne(e: ReturnType<typeof emitted>): DecodedEvent {
  const events = eventsOf(e.keys, e.inner, (d) => Buffer.from(d, 'base64'));
  expect(events.length).toBe(1);
  return events[0]!;
}

describe('v2 accounts (programs-summary §3 and §6)', () => {
  it('reads a Holding of 204 bytes with its hook data, at 92 without a delegate and 124 with one', async () => {
    const [mint, owner, delegate] = [k(), k(), k()];
    const hook = encodeKitHookData({ snapshot: 12_345n, owed: 678n, earlyLocked: 9n });
    const base = { version: 1, bump: 254, mint, owner, amount: bn(1_000), delegatedAmount: bn(0), frozen: false, hookData: Array.from(hook), reserved: Array(16).fill(0) };
    const plain = await encodeAccount('token', 'holding', { ...base, delegate: null });
    const delegated = await encodeAccount('token', 'holding', { ...base, delegate, delegatedAmount: bn(5) });
    expect(delegated.length).toBe(HOLDING_SIZE);
    expect([plain.readBigUInt64LE(74), Buffer.from(plain.subarray(92, 156)).equals(Buffer.from(hook)), Buffer.from(delegated.subarray(124, 188)).equals(Buffer.from(hook))]).toEqual([1_000n, true, true]);
    // An account is 204 bytes whatever the delegate: the coder reads past the zero padding.
    const padded = Buffer.concat([plain, Buffer.alloc(HOLDING_SIZE - plain.length)]);
    const h = decodeHolding(padded);
    expect([h.amount, h.delegate, h.hookData.length]).toEqual([1_000n, null, 64]);
    expect(kitHookDataOf(h)).toEqual({ snapshot: 12_345n, owed: 678n, earlyLocked: 9n });
    expect(decodeHolding(delegated).delegate?.equals(delegate)).toBe(true);
  });

  it('reads a Mint with its hook signer bump, and a Pool without protocol_fees_base', async () => {
    const mint = decodeMint(await encodeAccount('token', 'mint', { version: 1, decimals: 6, supply: bn(10), maxSupply: bn(10), mintAuthority: null, freezeAuthority: null, hookAuthority: null, metadataAuthority: null, hookProgram: a.KIT_PROGRAM, hookFlags: 145, name: 'N', symbol: 'S', uri: 'u', createdAt: bn(1), creator: k(), hookSignerBump: 255, reserved: Array(31).fill(0) }));
    expect([mint.hookProgram?.equals(a.KIT_PROGRAM), mint.hookFlags, mint.hookSignerBump]).toEqual([true, 145, 255]);
    const poolFields = (IDL.swap as unknown as { types: { name: string; type: { fields: { name: string }[] } }[] }).types.find((t) => t.name === 'Pool')!.type.fields.map((f) => f.name);
    expect(poolFields).not.toContain('protocol_fees_base');
    expect(poolFields).toContain('hook_signer_bump');
    // The share model's two fields (fee_model, protocol_share_bps) took three of the reserved bytes: the account stays 411.
    expect(CODERS.swap.accounts.size('pool')).toBe(411);
    const poolValue = { version: 1, bump: 1, lpMintBump: 2, baseMint: k(), quoteMint: SOL, lpMint: k(), baseVault: k(), quoteVault: k(), hookProgram: a.LAUNCH_PROGRAM, hookFlags: 1_985, lpFeeBps: 30, protocolFeeBps: 0, baseReserve: bn(1), quoteReserve: bn(2), virtualBase: bn(3), virtualQuote: bn(4), lpSupply: bn(5), protocolFeesQuote: bn(6), curve: true, creator: k(), createdAt: bn(7), lastSwapAt: bn(8), swapCount: bn(9), baseVolume: bn(10), quoteVolume: bn(11), hookSignerBump: 254, feeModel: FEE_MODEL_SHARE, protocolShareBps: 2_500, reserved: Array(60).fill(0) };
    const pool = decodePool(await encodeAccount('swap', 'pool', poolValue));
    expect([pool.protocolFeesQuote, pool.hookSignerBump, pool.hookFlags, 'protocolFeesBase' in pool]).toEqual([6n, 254, 1_985, false]);
    // A launch pool: the share model, a quarter of the cuts, no flat rate; an ordinary pool the flat model.
    expect([pool.feeModel, pool.protocolShareBps, pool.protocolFeeBps, poolSharesCuts(pool)]).toEqual([FEE_MODEL_SHARE, 2_500, 0, true]);
    const flat = decodePool(await encodeAccount('swap', 'pool', { ...poolValue, hookProgram: null, protocolFeeBps: 100, feeModel: FEE_MODEL_FLAT, protocolShareBps: 0, curve: false }));
    expect([flat.feeModel, flat.protocolShareBps, flat.protocolFeeBps, poolSharesCuts(flat)]).toEqual([FEE_MODEL_FLAT, 0, 100, false]);
  });

  it('reads the DEX Config with the flat rate and the launch share (2026-10-07) in the former reserved bytes', async () => {
    expect(CODERS.swap.accounts.size('config')).toBe(8 + 1 + 1 + 32 + 2 + 32 + 32 + 8 + 1 + 8 + 2 + 62);
    const config = decodeSwapConfig(await encodeAccount('swap', 'config', { version: 1, bump: 254, admin: k(), protocolFeeBps: 100, feeCollector: k(), treasury: k(), poolCreationFeeLamports: bn(0), paused: false, poolsCreated: bn(3), launchProtocolShareBps: 2_500, reserved: Array(62).fill(0) }));
    expect([config.protocolFeeBps, config.launchProtocolShareBps, config.poolsCreated]).toEqual([100, 2_500, 3n]);
  });

  it('reads a LaunchConfig (build your own, §5.7): 176 bytes, the rules, the creator fee, the hook and its flags, the label', async () => {
    const [creator, hook] = [k(), k()];
    const value = { version: 1, creator, rules: { ...rulesRaw, holderFeeBuyBps: 0, holderFeeSellBps: 0, maxWalletBps: 0, creatorLockSecs: 0, earlyWindowSecs: 0, earlyLockSecs: 0 }, creatorFeeBps: 100, customHook: hook, customHookFlags: 65, label: 'taxed', createdAt: bn(1_800_000_000), authorShareBps: 2_500, reserved: Array(30).fill(0) };
    const bytes = await encodeAccount('launch', 'launchConfig', value);
    // The label is a Borsh string: 4 bytes of length plus its bytes; the account is sized for 32 bytes of label.
    expect(bytes.length).toBe(LAUNCH_CONFIG_ACCOUNT_SIZE - (32 - 5));
    const c = decodeLaunchConfigAccount(Buffer.concat([bytes, Buffer.alloc(LAUNCH_CONFIG_ACCOUNT_SIZE - bytes.length)]));
    expect([c.creator.equals(creator), c.customHook?.equals(hook), c.customHookFlags, c.label, c.creatorFeeBps, c.rules.burnBuyBps, c.createdAt, c.authorShareBps]).toEqual([true, true, 65, 'taxed', 100, 50, 1_800_000_000, 2_500]);
    const kitOnly = decodeLaunchConfigAccount(await encodeAccount('launch', 'launchConfig', { ...value, rules: rulesRaw, customHook: null, customHookFlags: 0, label: '' }));
    expect([kitOnly.customHook, kitOnly.customHookFlags, kitOnly.label, kitOnly.rules]).toEqual([null, 0, '', rulesRaw]);
  });

  it('reads the launch Config with its rule bounds, and a Launch with its rules, kit fields, config and custom hook', async () => {
    expect(CODERS.launch.accounts.size('config')).toBe(250);
    // 498 before the config (32), the custom hook (1 + 32) and its flags (2) were added before the reserved bytes.
    expect(CODERS.launch.accounts.size('launch')).toBe(565);
    const ruleBounds = { maxHolderFeeBps: 200, maxBurnBps: 100, maxRulesFeeBps: 300, minMaxWalletBps: 100, maxMaxWalletBps: 500, maxCreatorLockSecs: 7_776_000, maxEarlyWindowSecs: 300, maxEarlyLockSecs: 604_800 };
    const config = decodeLaunchConfig(await encodeAccount('launch', 'config', { version: 1, bump: 255, admin: k(), treasury: k(), quoteMint: SOL, launchFeeLamports: bn(10_000_000), lpFeeBps: 30, maxCreatorFeeBps: 200, sniperWindowSecs: bn(30), sniperStartBps: 8_000, curveBps: 7_500, supply: bn(10n ** 15n), decimals: 6, minVirtualQuote: bn(1), maxVirtualQuote: bn(2), paused: false, launches: bn(3), ruleBounds, reserved: Array(64).fill(0) }));
    expect(config.ruleBounds).toEqual(ruleBounds);
    const mintKey = k();
    const launchKey = a.launchAddress(mintKey);
    const value = {
      version: 1, bump: 255, mint: mintKey, creator: k(), pool: a.launchPoolAddress(mintKey, SOL, 30), quoteMint: SOL, status: 0, creatorFeeBps: 50, lpFeeBps: 30, sniperWindowSecs: bn(30), sniperStartBps: 8_000,
      virtualQuote: bn(1), virtualBase: bn(2), graduationQuote: bn(3), curveTokens: bn(4), reserveTokens: bn(5), reserveHolding: k(), quoteHolding: k(), lpHolding: k(), createdAt: bn(1_800_000_000), graduatedAt: bn(0),
      creatorFeesAccrued: bn(6), creatorFeesClaimed: bn(7), graduationTopup: bn(0), graduationBurned: bn(0), rules: rulesRaw, modules: 15, kitConfig: a.kitConfigAddress(mintKey), holderVault: a.holderVaultAddress(mintKey, SOL), kitCallerBump: 253,
      creatorUnlockAt: bn(1_800_000_000 + 30 * 86_400), earlyWindowEnd: bn(1_800_000_060), earlyUnlockAt: bn(1_800_003_600), creatorBought: true, holderFeesAccrued: bn(8), burnedOnTrades: bn(9), config: PublicKey.default, customHook: null, customHookFlags: 0, authorShareBps: 3_000, authorFeesPaid: bn(77), reserved: Array(22).fill(0),
    };
    const launch = decodeLaunch(await encodeAccount('launch', 'launch', value));
    expect(launch.mint.toBase58()).toBe(mintKey.toBase58());
    expect([launch.rules, launch.modules, launch.kitCallerBump, launch.creatorBought, launch.holderFeesAccrued, launch.burnedOnTrades, launch.authorShareBps, launch.authorFeesPaid]).toEqual([rulesRaw, 15, 253, true, 8n, 9n, 3_000, 77n]);
    // Inline rules: the default key for the config, no custom hook.
    expect([launchConfigOf(launch), launch.customHook, launch.customHookFlags, hasCustomHook(launch)]).toEqual([null, null, 0, false]);
    const [configKey, hook] = [k(), k()];
    const own = decodeLaunch(await encodeAccount('launch', 'launch', { ...value, rules: { ...rulesRaw, holderFeeBuyBps: 0, holderFeeSellBps: 0, maxWalletBps: 0, creatorLockSecs: 0, earlyWindowSecs: 0, earlyLockSecs: 0 }, modules: 0, config: configKey, customHook: hook, customHookFlags: 65 }));
    expect([launchConfigOf(own)?.equals(configKey), own.customHook?.equals(hook), own.customHookFlags, hasCustomHook(own)]).toEqual([true, true, 65, true]);
    expect(kitModulesOf(launch.rules)).toBe(15);
    expect(apiLaunchRules(launch)).toEqual<LaunchRules>({ holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 50, burnSellBps: 50, maxWalletBps: 500, creatorUnlockAt: 1_800_000_000 + 30 * 86_400, earlyWindowEndsAt: 1_800_000_060, earlyUnlockAt: 1_800_003_600, walletsOnly: true });
    expect(apiLaunchRules({ ...launch, rules: { ...rulesRaw, holderFeeBuyBps: 0, holderFeeSellBps: 0 }, creatorUnlockAt: 0, earlyWindowEnd: 0, earlyUnlockAt: 0 })).toMatchObject({ creatorUnlockAt: null, earlyWindowEndsAt: null, earlyUnlockAt: null, walletsOnly: false });
    expect(launchRulesInputOf(launch.rules)).toEqual({ holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 50, burnSellBps: 50, maxWalletBps: 500, creatorLockDays: 30, earlyWindowSecs: 60, earlyLockSecs: 3_600 });
    expect(launchRulesFromInput(launchRulesInputOf(launch.rules))).toEqual(rulesRaw);
    void launchKey;
  });

  it('reads a KitConfig of 431 bytes at its fixed offsets, feeds the mirror and verifies a kit token (§4.15)', async () => {
    const mintKey = k();
    const pool = a.launchPoolAddress(mintKey, SOL, 30);
    const value = {
      version: 1, bump: 254, kitCallerBump: 255, modules: 15, graduated: false, eligible: bn(3_000_000_000_000n), minEligible: bn(1_000_000_000_000n), mint: mintKey, launch: a.launchAddress(mintKey), pool, creator: k(), rewardMint: SOL, rewardVault: a.rewardVaultAddress(mintKey, SOL),
      supplyAtInit: bn(10n ** 15n), maxWalletBps: 500, maxWalletAmount: bn(5n * 10n ** 13n), creatorUnlockAt: bn(1), earlyWindowEnd: bn(2), earlyUnlockAt: bn(3), accPerShare: bn(7_000_000), rem: bn(11), held: bn(0), seen: bn(21_000_000),
      streamRemaining: bn(0), streamLast: bn(0), streamEnd: bn(0), totalDistributed: bn(21_000_000), totalClaimed: bn(0), totalShared: bn(0), createdAt: bn(1_800_000_000), streamNext: bn(0), creatorIsCompanion: false, reserved: Array(55).fill(0),
    };
    const bytes = await encodeAccount('kit', 'kitConfig', value);
    expect(bytes.length).toBe(KIT_CONFIG_SIZE);
    expect([bytes.readBigUInt64LE(13), bytes.subarray(29, 61).equals(mintKey.toBuffer()), bytes.subarray(93, 125).equals(pool.toBuffer()), bytes.readBigUInt64LE(303), bytes.readBigUInt64LE(367)]).toEqual([3_000_000_000_000n, true, true, 21_000_000n, 0n]);
    const config = decodeKitConfig(bytes);
    expect([config.eligible, config.accPerShare, config.streamNext, config.modules]).toEqual([3_000_000_000_000n, 7_000_000n, 0n, 15]);
    // 21,000,000 lamports over 3e12 eligible units: a holder of 1e12 since accumulator 0 is owed 7,000,000.
    const holder = { snapshot: 0n, owed: 0n, earlyLocked: 0n };
    expect(rewardsClaimable(kitRewardsOf(config), 21_000_000n, 1_800_000_100, 1_000_000_000_000n, holder)).toEqual({ claimable: 7_000_000n, payable: 7_000_000n });
    expect([kitExcludes(config, pool), kitExcludes(config, a.launchAddress(mintKey)), kitExcludes(config, k())]).toEqual([true, true, false]);
    // §4.15: the kit as hook, no hook or mint authority, its flags, the config's launch and pool.
    const mint = decodeMint(await encodeAccount('token', 'mint', { version: 1, decimals: 6, supply: bn(10n ** 15n), maxSupply: bn(10n ** 15n), mintAuthority: null, freezeAuthority: null, hookAuthority: null, metadataAuthority: null, hookProgram: a.KIT_PROGRAM, hookFlags: kitMintFlags(15), name: 'N', symbol: 'S', uri: 'u', createdAt: bn(1), creator: k(), hookSignerBump: 255, reserved: Array(31).fill(0) }));
    const launch = { mint: mintKey, pool } as Parameters<typeof isVerifiedKitToken>[2];
    expect(isVerifiedKitToken(mintKey, mint, launch, config)).toBe(true);
    expect(isVerifiedKitToken(mintKey, { ...mint, hookFlags: 1 }, launch, config)).toBe(false);
    expect(isVerifiedKitToken(mintKey, { ...mint, hookAuthority: k() }, launch, config)).toBe(false);
    expect(isVerifiedKitToken(mintKey, mint, { ...launch, pool: k() }, config)).toBe(false);
    expect(decodeKitHookData(new Uint8Array(64))).toEqual(holder);
  });
});

describe('v2 events, decoded by the program that emitted them', () => {
  it('reads Transferred with its deltas and HookDataWritten', () => {
    const [mint, owner] = [k(), k()];
    const delta = { holding: k(), owner: k(), amount: bn(2), post: bn(9) };
    const ev = decodeOne(emitted('token', a.TOKEN_PROGRAM, 'transferred', { mint, source: k(), destination: k(), sourceOwner: owner, destinationOwner: k(), authority: owner, amount: bn(10), deltas: [delta], sourcePost: bn(1), destinationPost: bn(8), slot: bn(5), ts: bn(77) }));
    expect([ev.program, ev.name]).toEqual(['token', 'transferred']);
    const t = typedEvent(ev);
    expect(t).toMatchObject({ kind: 'token.Transferred', mint: mint.toBase58(), amount: 10n, deltas: [{ holding: delta.holding.toBase58(), owner: delta.owner.toBase58(), amount: 2n, post: 9n }], destinationPost: 8n, ts: 77 });
    const data = Array.from({ length: 64 }, (_, i) => i);
    const written = typedEvent(decodeOne(emitted('token', a.TOKEN_PROGRAM, 'hookDataWritten', { mint, holding: k(), owner, data })));
    expect(written?.kind).toBe('token.HookDataWritten');
    expect(written && 'data' in written ? [...written.data] : null).toEqual(data);
  });

  it('reads Swapped v2 and tells a launch swap\'s creator fee, holder fee and burn apart', () => {
    const [launchQuote, holderVault] = [k(), k()];
    // A buy of 1,000 under the share model: cuts of 15 (creator 5, holders 10), Bordrless's quarter of them (4, rounded up) taken off what reached the vault.
    const base = { pool: k(), trader: k(), recipient: k(), amountIn: bn(1_000), burnIn: bn(0), cutsIn: bn(15), receivedIn: bn(985), lpFee: bn(3), protocolFee: bn(4), lpFeeBps: 30, amountOut: bn(5_000), burnOut: bn(25), cutsOut: bn(0), deliveredOut: bn(4_975), baseReserve: bn(1), quoteReserve: bn(2), virtualBase: bn(3), virtualQuote: bn(4), swapCount: bn(5), slot: bn(6), ts: bn(7) };
    const buy = typedEvent(decodeOne(emitted('swap', a.SWAP_PROGRAM, 'swapped', { ...base, direction: 1, deltasIn: [{ holding: launchQuote, amount: bn(5) }, { holding: holderVault, amount: bn(10) }], deltasOut: [] }))) as SwappedEvent;
    expect([buy.kind, buy.recipient, buy.deltasIn.length, buy.burnOut, buy.deliveredOut, buy.cutsIn, buy.cutsOut, buy.protocolFee]).toEqual(['swap.Swapped', base.recipient.toBase58(), 2, 25n, 4_975n, 15n, 0n, 4n]);
    expect(launchSwapCuts(buy, launchQuote.toBase58(), holderVault.toBase58())).toEqual({ creatorFee: 5n, holderFee: 10n, burn: 25n });
    const sell = typedEvent(decodeOne(emitted('swap', a.SWAP_PROGRAM, 'swapped', { ...base, direction: 0, burnIn: bn(5), burnOut: bn(0), cutsIn: bn(0), cutsOut: bn(9), protocolFee: bn(3), deltasIn: [], deltasOut: [{ holding: launchQuote, amount: bn(3) }, { holding: holderVault, amount: bn(6) }] }))) as SwappedEvent;
    expect(launchSwapCuts(sell, launchQuote.toBase58(), holderVault.toBase58())).toEqual({ creatorFee: 3n, holderFee: 6n, burn: 5n });
    expect([sell.cutsIn, sell.cutsOut, sell.protocolFee]).toEqual([0n, 9n, 3n]);
    const collected = typedEvent(decodeOne(emitted('swap', a.SWAP_PROGRAM, 'protocolFeesCollected', { pool: base.pool, quoteAmount: bn(42), collector: k(), ts: bn(8) })));
    expect(collected).toMatchObject({ kind: 'swap.ProtocolFeesCollected', quoteAmount: 42n, ts: 8 });
  });

  it('reads LaunchCreated v2 with its rules, kit config and holder vault, and the config and custom hook of a build-your-own launch', () => {
    const kitConfig = k();
    const value = { launch: k(), mint: k(), creator: k(), pool: k(), quoteMint: SOL, lpMint: k(), name: 'Launch EVRY', symbol: 'EVRY', uri: 'u', supply: bn(10n ** 15n), decimals: 6, creatorFeeBps: 50, lpFeeBps: 30, sniperWindowSecs: bn(30), sniperStartBps: 8_000, virtualQuote: bn(1), virtualBase: bn(2), graduationQuote: bn(3), curveTokens: bn(4), reserveTokens: bn(5), launchFeeLamports: bn(6), rules: rulesRaw, modules: 15, kitConfig, holderVault: null, creatorUnlockAt: bn(10), earlyWindowEnd: bn(0), earlyUnlockAt: bn(0), config: null, customHook: null, customHookFlags: 0, slot: bn(1), ts: bn(2) };
    const ev = typedEvent(decodeOne(emitted('launch', a.LAUNCH_PROGRAM, 'launchCreated', value)));
    expect(ev).toMatchObject({ kind: 'launch.LaunchCreated', symbol: 'EVRY', supply: 10n ** 15n, rules: rulesRaw, modules: 15, kitConfig: kitConfig.toBase58(), holderVault: null, creatorUnlockAt: 10, earlyWindowEnd: 0, config: null, customHook: null, customHookFlags: 0 });
    const [config, hook] = [k(), k()];
    const own = typedEvent(decodeOne(emitted('launch', a.LAUNCH_PROGRAM, 'launchCreated', { ...value, modules: 0, kitConfig: null, config, customHook: hook, customHookFlags: 65 })));
    expect(own).toMatchObject({ config: config.toBase58(), customHook: hook.toBase58(), customHookFlags: 65, kitConfig: null });
    const made = typedEvent(decodeOne(emitted('launch', a.LAUNCH_PROGRAM, 'launchConfigCreated', { config, creator: k(), rules: rulesRaw, creatorFeeBps: 100, customHook: hook, customHookFlags: 65, label: 'taxed', ts: bn(3) }))) as LaunchConfigCreatedEvent;
    expect(made).toMatchObject({ kind: 'launch.LaunchConfigCreated', config: config.toBase58(), customHook: hook.toBase58(), customHookFlags: 65, label: 'taxed', creatorFeeBps: 100, rules: rulesRaw, ts: 3 });
  });

  it('reads the kit\'s KitInstalled, KitGraduated, RewardsClaimed and RewardsShared', () => {
    const mint = k();
    const installed = typedEvent(decodeOne(emitted('kit', a.KIT_PROGRAM, 'kitInstalled', { mint, kitConfig: k(), launch: k(), pool: k(), creator: k(), rewardMint: SOL, rewardVault: k(), modules: 7, supply: bn(10n ** 15n), minEligible: bn(10n ** 12n), maxWalletBps: 200, maxWalletAmount: bn(2n * 10n ** 13n), creatorUnlockAt: bn(5), earlyWindowEnd: bn(0), earlyUnlockAt: bn(0), ts: bn(1) })));
    expect(installed).toMatchObject({ kind: 'kit.KitInstalled', mint: mint.toBase58(), modules: 7, minEligible: 10n ** 12n, maxWalletAmount: 2n * 10n ** 13n });
    expect(typedEvent(decodeOne(emitted('kit', a.KIT_PROGRAM, 'kitGraduated', { mint, ts: bn(9) })))).toEqual({ kind: 'kit.KitGraduated', mint: mint.toBase58(), ts: 9 });
    const owner = k();
    expect(typedEvent(decodeOne(emitted('kit', a.KIT_PROGRAM, 'rewardsClaimed', { mint, owner, amount: bn(5), owedLeft: bn(1), totalClaimed: bn(50) })))).toEqual({ kind: 'kit.RewardsClaimed', mint: mint.toBase58(), owner: owner.toBase58(), amount: 5n, owedLeft: 1n, totalClaimed: 50n });
    expect(typedEvent(decodeOne(emitted('kit', a.KIT_PROGRAM, 'rewardsShared', { mint, from: owner, amount: bn(1_000_000), totalShared: bn(3_000_000) })))).toEqual({ kind: 'kit.RewardsShared', mint: mint.toBase58(), from: owner.toBase58(), amount: 1_000_000n, totalShared: 3_000_000n });
  });

  it('reads a game\'s events (the companion\'s and the lottery hook\'s) only when asked, so an indexed transaction\'s ordinals never move', () => {
    const [game, mint] = [k(), k()];
    const revealed = emitted('companion', a.COMPANION_PROGRAM, 'drawRevealed', { game, mint, round: 82_870, seed: Array(32).fill(7), randomness: Array(64).fill(9), cranker: k() });
    const decode = (d: string) => Buffer.from(d, 'base64');
    expect(eventsOf(revealed.keys, revealed.inner, decode)).toEqual([]);
    const both = [...INDEXED_EVENT_PROGRAMS, ...GAME_EVENT_PROGRAMS];
    const [ev] = eventsOf(revealed.keys, revealed.inner, decode, both);
    expect([ev?.program, ev?.name, ev?.data.round, ev?.data.mint]).toEqual(['companion', 'drawRevealed', 82_870, mint.toBase58()]);
    const rolled = emitted('companion', a.COMPANION_PROGRAM, 'rolledOver', { game, mint, round: 7, reason: { oracleSilent: {} }, pendingPot: bn(5) });
    expect(eventsOf(rolled.keys, rolled.inner, decode, both)[0]?.data).toMatchObject({ round: 7, reason: { oracleSilent: {} }, pendingPot: '5' });
    const entered = emitted('lotteryHook', a.LOTTERY_HOOK_PROGRAM, 'entered', { mint, holding: k(), owner: k(), round: 82_871, start: bn(100), weight: bn(50), total: bn(150) });
    expect(eventsOf(entered.keys, entered.inner, decode)).toEqual([]);
    expect(eventsOf(entered.keys, entered.inner, decode, both)[0]).toMatchObject({ program: 'lotteryHook', name: 'entered', data: { round: 82_871, start: '100', weight: '50', total: '150' } });
    expect(INDEXED_EVENT_PROGRAMS).not.toContain('companion');
  });

  it('ignores a self-CPI that does not come from the program\'s event authority', () => {
    const e = emitted('kit', a.KIT_PROGRAM, 'kitGraduated', { mint: k(), ts: bn(9) });
    const forged = { keys: [e.keys[0]!, k().toBase58()], inner: e.inner };
    expect(eventsOf(forged.keys, forged.inner, (d) => Buffer.from(d, 'base64'))).toEqual([]);
  });
});

describe('errors are explained by the program that failed (codes overlap)', () => {
  it('reads the same code as three different errors in three programs', () => {
    expect([explainProgramError('kit', 6006).name, explainProgramError('swap', 6006).name, explainProgramError('token', 6006).name]).toEqual(['CreatorLocked', 'FeeTooHigh', 'SameAccount']);
    expect(explainProgramError(a.KIT_PROGRAM, 6008)).toMatchObject({ program: 'kit', name: 'MaxWalletExceeded', programId: a.KIT_PROGRAM.toBase58() });
    expect(explainProgramError('swap', 6036)).toMatchObject({ name: 'BadHookSigner', message: "the hook signer is not this program's signer for the pool's hook program" });
    expect(explainProgramError('launch', 6027).name).toBe('WrongHolderVault');
    // The build-your-own errors (§5.7, §5.8), appended after it, each explained in the launch form's words.
    expect(explainProgramError('launch', 6028)).toMatchObject({ name: 'CustomHookWithKitRules' });
    expect(explainProgramError('launch', 6031).explanation).toMatch(/^Prepare the hook for this mint first/);
    expect(explainProgramError('launch', 6035)).toMatchObject({ name: 'ConfigMismatch' });
    expect(explainProgramError('launch', 6037)).toMatchObject({ name: 'InvalidLabel', explanation: 'A config’s label is at most 32 bytes.' });
    expect(explainProgramError('token', 6024).explanation).toMatch(/claim them before closing/);
    expect(explainProgramError('launch', 2006)).toMatchObject({ name: 'ConstraintSeeds' });
    expect(explainProgramError('kit', 6999).name).toBeNull();
    expect(explainProgramError('swap', 6037)).toMatchObject({ name: 'NotBridgedSol', message: "the pool's quote is not bridged SOL" });
    expect([PROGRAM_ERRORS.kit.size, PROGRAM_ERRORS.launch.size, PROGRAM_ERRORS.swap.size, PROGRAM_ERRORS.token.size, PROGRAM_ERRORS.bridge.size, PROGRAM_ERRORS.taxHook.size]).toEqual([29, 44, 38, 27, 14, 6]);
  });

  it('explains the companion\'s game errors and the lottery hook\'s, read from the logs of a failed step', () => {
    expect(explainProgramError('companion', 6039)).toMatchObject({ program: 'companion', name: 'NotTheWinner', explanation: 'This holding does not hold the drawn ticket.' });
    // 6045 is no longer returned (a held breaker rolls the round over); it keeps its number.
    expect(explainProgramError('companion', 6045).name).toBe('OracleUnanswered');
    expect(explainProgramError('companion', 6048)).toMatchObject({ name: 'StaleSeed', explanation: expect.stringMatching(/newest slot/) });
    // v1's codes keep their numbers: v2 only appends.
    expect(explainProgramError('companion', 6011).name).toBe('CustomHookUnsupported');
    expect([PROGRAM_ERRORS.companion.size, PROGRAM_ERRORS.lotteryHook.size]).toEqual([49, 6]);
    expect(explainProgramError('lotteryHook', 6005)).toMatchObject({ program: 'lotteryHook', name: 'NotEligible' });
    const companionId = a.COMPANION_PROGRAM.toBase58();
    const failed = explainFailure([`Program ${companionId} invoke [1]`, `Program ${companionId} failed: custom program error: 0x${(6043).toString(16)}`])!;
    expect([failed.program, failed.name, failed.explanation]).toEqual(['companion', 'DrawLate', 'Too late: a draw’s claims end with the round after the drawn one.']);
    expect(explainProgramError(a.LOTTERY_HOOK_PROGRAM, 6002)).toMatchObject({ program: 'lotteryHook', name: 'BadRoundSecs' });
  });

  it('finds the innermost failure in the logs of a swap that the kit refused', () => {
    const [swapId, tokenId, kitId] = [a.SWAP_PROGRAM, a.TOKEN_PROGRAM, a.KIT_PROGRAM].map(String);
    const logs = [
      `Program ${swapId} invoke [1]`,
      `Program ${tokenId} invoke [2]`,
      `Program ${kitId} invoke [3]`,
      'Program log: AnchorError occurred. Error Code: MaxWalletExceeded. Error Number: 6008. Error Message: the destination would hold more than the max wallet.',
      `Program ${kitId} consumed 9000 of 180000 compute units`,
      `Program ${kitId} failed: custom program error: 0x1778`,
      `Program ${tokenId} consumed 20000 of 190000 compute units`,
      `Program ${tokenId} failed: custom program error: 0x1778`,
      `Program ${swapId} consumed 40000 of 200000 compute units`,
      `Program ${swapId} failed: custom program error: 0x1778`,
    ];
    expect(failedProgram(logs)).toEqual({ programId: kitId, code: 6008, message: 'custom program error: 0x1778' });
    const explained = explainFailure(logs, { InstructionError: [2, { Custom: 6008 }] })!;
    expect([explained.program, explained.name, explained.explanation]).toEqual(['kit', 'MaxWalletExceeded', 'This would take the receiving wallet above max wallet. Buy less, or wait for graduation, when max wallet lifts.']);
    // The same number from the DEX is another error.
    expect(explainFailure([`Program ${swapId} failed: custom program error: 0x1778`])?.name).toBe('CurveNeedsHook');
    expect(explainFailure(['Transfer: insufficient lamports 5, need 10'])?.explanation).toBe('Not enough SOL to pay for this transaction.');
    expect(explainFailure([], null)).toBeNull();
    expect(explainFailure([], { InstructionError: [0, { Custom: 3012 }] })).toMatchObject({ program: null, name: 'AccountNotInitialized' });
  });
});
