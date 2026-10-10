/**
 * Audit 3a (integration, r1): proofs of concept and measurements for the SDK's phase-3a code
 * (log-3a-audit-integration-r1.md). Sizes are of the v0 transactions the keeper and the server
 * build (compute limit and priority price first, the protocol's 22-address table); the label cases
 * are ones `vectors/risk-labels.json` does not cover.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type AccountInfo, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { STUDIO_UPGRADE_AUTHORITY } from '@bordrless/shared';
import * as a from './addresses.ts';
import { LOADER_V4, executableHash, timelockAddress } from './authority.ts';
import { COMPANION_DEFAULTS, companion, type GameArgs, type StrategyArgs } from './companion.ts';
import { studioGameHook } from './gameKinds.ts';
import { setComputeUnitLimit, setComputeUnitPrice, launch } from './instructions.ts';
import { lotteryHook } from './lotteryHook.ts';
import { calleeExempt, hookCallees, hookRiskLabel, riskLabelOf } from './risk.ts';
import { encodeHookAccountList } from './hooks.ts';
import { loader, timelock } from './timelock.ts';
import { buildV0Transaction, protocolLookupTable, transactionSize } from './transactions.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const PACKET = 1_232;
const table = protocolLookupTable(k());
/** As the keeper and the server compile: a compute limit and (mainnet) a priority price, then the instructions, through the protocol table. */
const v0Size = (payer: PublicKey, ixs: TransactionInstruction[]): number => transactionSize(buildV0Transaction(payer, [setComputeUnitLimit(1_400_000), setComputeUnitPrice(20_000n), ...ixs], k().toBase58(), [table]));

describe('audit 3a: transaction sizes with the 22-address table', () => {
  const [payer, mint, cranker, strategy, studioHook, authority] = [k(), k(), k(), k(), k(), k()];
  const extras = [k(), k()];
  const split = { buybackBps: 3_000, holdersBps: 0, beneficiaryBps: 0 };
  const g = (hook: PublicKey): GameArgs => ({ kind: 'strategy', hook, split, potBps: 7_000, roundSecs: 3_600, minPot: 100_000_000n, prizeBps: 0, claimWindowSecs: 600, maxAttempts: 0 });
  const s: StrategyArgs = { strategy, budgetBps: 5_000, maxShareBps: 2_500, maxPerTx: 4, planCuMax: 150_000, entitleCuMax: 60_000, minWeight: 1n };
  const create = companion.create(payer, payer, mint, { ...COMPANION_DEFAULTS, split: { buybackBps: 10_000, holdersBps: 0, beneficiaryBps: 0 }, fund: 500_000_000n });
  const sizes: Record<string, number> = {};
  it('measures every phase-3a transaction', () => {
    sizes['plan_period, 2 extras'] = v0Size(cranker, [companion.planPeriod(cranker, mint, a.LOTTERY_HOOK_PROGRAM, strategy, k(), extras, 500_000)]);
    sizes['claim_fees + plan_period (keeper bundle), 2 extras'] = v0Size(cranker, [companion.claimFees(cranker, mint, a.LOTTERY_HOOK_PROGRAM), companion.planPeriod(cranker, mint, a.LOTTERY_HOOK_PROGRAM, strategy, k(), extras, 500_000)]);
    sizes['pay_strategy x4, 2 extras'] = v0Size(cranker, [companion.payStrategy(cranker, mint, a.LOTTERY_HOOK_PROGRAM, strategy, extras, 500_000, [k(), k(), k(), k()])]);
    sizes['pay_strategy x4, 2 extras, Studio ticket hook'] = v0Size(cranker, [companion.payStrategy(cranker, mint, studioHook, strategy, extras, 500_000, [k(), k(), k(), k()])]);
    sizes['setup: create + lottery prepare + create_strategy_game (2 extras, strategy timelocked)'] = v0Size(payer, [create, lotteryHook.prepare(payer, mint, 3_600), companion.createStrategyGame(payer, mint, g(a.LOTTERY_HOOK_PROGRAM), s, [], true, extras)]);
    sizes['setup: create + Studio prepare + create_strategy_game (hook vetting timelocked, strategy timelocked, 2 extras)'] = v0Size(payer, [create, studioGameHook.prepare(studioHook, payer, mint), companion.createStrategyGame(payer, mint, g(studioHook), s, companion.vettingAccounts(studioHook, true), true, extras)]);
    sizes['setup: create + Studio prepare + create_game_v2_attested (timelocked)'] = v0Size(payer, [create, studioGameHook.prepare(studioHook, payer, mint), companion.createGameV2Attested(payer, mint, { ...g(studioHook), kind: 'streak', prizeBps: 10_000, roundSecs: 86_400, claimWindowSecs: 3_600 }, { timerSecs: 0, minTokens: 0n, minStreakSecs: 3_600, minWeight: 1n }, true)]);
    sizes['attest'] = v0Size(authority, [companion.attest(authority, studioHook, { buildHash: '11'.repeat(32), sourceHash: '22'.repeat(32), templateCommit: '33'.repeat(20), simVersion: 1, simPass: true, cutMaxBps: 0, capBps: 0, review: 'pass', kind: 'gameHook' })]);
    sizes['set_hook_status_v2'] = v0Size(authority, [companion.setHookStatusV2(authority, studioHook, { audited: true, potCap: 0n, blocked: false }, '44'.repeat(32))]);
    sizes['timelock register'] = v0Size(payer, [timelock.register(payer, authority, studioHook, 3 * 86_400, authority)]);
    sizes['timelock propose'] = v0Size(authority, [timelock.propose(authority, studioHook, k(), 200_000)]);
    sizes['loader extend + timelock execute (one transaction)'] = v0Size(payer, [loader.extendProgram(a.programDataAddress(studioHook), studioHook, payer, 10_240), timelock.execute(payer, studioHook, k(), authority)]);
    sizes['create_config_timelocked'] = v0Size(payer, [launch.createConfigTimelocked(payer, k(), { rules: { holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: 0, burnSellBps: 0, maxWalletBps: 0, creatorLockSecs: 0, earlyWindowSecs: 0, earlyLockSecs: 0 }, creatorFeeBps: 100, customHook: studioHook, customHookFlags: 1, label: 'x'.repeat(32) } as never)]);
    console.log(sizes);
    for (const [name, size] of Object.entries(sizes)) expect(size, name).toBeLessThanOrEqual(PACKET);
  });
  it('pay_strategy with 2 extras: 4 candidates need the 22-address table, 3 fit the 18-address core table', () => {
    // Round 1 added the strategy's ProgramData and timelock (its class is read before every question): +64 bytes.
    const core = protocolLookupTable(k(), a.PROTOCOL_LOOKUP_TABLE.slice(0, 18));
    const ixs = (n: number) => [setComputeUnitLimit(1_400_000), setComputeUnitPrice(20_000n), companion.payStrategy(cranker, mint, a.LOTTERY_HOOK_PROGRAM, strategy, extras, 500_000, Array.from({ length: n }, k))];
    const x4at18 = transactionSize(buildV0Transaction(cranker, ixs(4), k().toBase58(), [core]));
    const x3at18 = transactionSize(buildV0Transaction(cranker, ixs(3), k().toBase58(), [core]));
    const x4at22 = transactionSize(buildV0Transaction(cranker, ixs(4), k().toBase58(), [table]));
    console.log({ 'pay_strategy x4, 18-address table': x4at18, 'x3, 18': x3at18, 'x4, 22': x4at22 });
    expect(x4at22).toBeLessThanOrEqual(PACKET);
    expect(x3at18).toBeLessThanOrEqual(PACKET);
  });
});

/** A loader-v4 program account: `[slot u64][authority 32][status u64]` then its code. */
const v4Program = (authority: PublicKey, code: Buffer, slot = 7n): AccountInfo<Buffer> => {
  const head = Buffer.alloc(48);
  head.writeBigUInt64LE(slot, 0);
  authority.toBuffer().copy(head, 8);
  head.writeBigUInt64LE(1n, 40);
  return { owner: LOADER_V4, data: Buffer.concat([head, code]), executable: true, lamports: 1, rentEpoch: 0 };
};
/** A `HookStatus` as `set_hook_status_v2` leaves it: audited, its hash in what was `reserved`. */
const auditedStatus = (hook: PublicKey, hashHex: string): AccountInfo<Buffer> => {
  const d = Buffer.alloc(124);
  d[8] = 1;
  hook.toBuffer().copy(d, 10);
  d[42] = 1;
  Buffer.from(hashHex, 'hex').copy(d, 92);
  return { owner: a.COMPANION_PROGRAM, data: d, executable: false, lamports: 1, rentEpoch: 0 };
};

describe('audit 3a: hookRiskLabel', () => {
  it('F-S1: caches a loader-v4 program’s hash under "none": after Bordrless upgrades an audited v4 hook, the label still says "Audited."', async () => {
    const program = k();
    const studio = new PublicKey(STUDIO_UPGRADE_AUTHORITY);
    const codeA = Buffer.from('audited code, version A');
    let accounts = new Map<string, AccountInfo<Buffer>>([
      [program.toBase58(), v4Program(studio, codeA)],
      [a.hookStatusAddress(program).toBase58(), auditedStatus(program, executableHash(codeA))],
    ]);
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((x) => accounts.get(x.toBase58()) ?? null),
      getAccountInfo: async (x: PublicKey) => accounts.get(x.toBase58()) ?? null,
    } as unknown as Connection;
    expect((await hookRiskLabel(connection, program)).audited).toBe('current');
    // Upgraded (new code, a new slot in the v4 header).
    const codeB = Buffer.from('different code, version B');
    accounts = new Map([...accounts, [program.toBase58(), v4Program(studio, codeB, 99n)]]);
    const pure = riskLabelOf({ programId: program, program: { ...accounts.get(program.toBase58())!, data: accounts.get(program.toBase58())!.data }, programdata: null, timelock: null, timelockProgramdata: null, status: accounts.get(a.hookStatusAddress(program).toBase58())!, attestation: null }, 0, executableHash(codeB));
    expect(pure.audited).toBe('stale');
    // Fixed (round 1): the cache is keyed by the v4 header's slot, so the new code is hashed.
    const fresh = await hookRiskLabel(connection, program);
    expect(fresh.audited).toBe('stale');
    expect(fresh.words).not.toBe('Audited.');
  });

  it('F-S2: a closed program (ProgramData gone, every transfer fails) is labelled "Its owner can change this code at any time."', () => {
    const program = k();
    const data = Buffer.alloc(36);
    data.writeUInt32LE(2, 0);
    a.programDataAddress(program).toBuffer().copy(data, 4);
    const l = riskLabelOf({ programId: program, program: { owner: a.BPF_LOADER_UPGRADEABLE, data, executable: true }, programdata: null, timelock: null, timelockProgramdata: null, status: null, attestation: null }, 0);
    // Fixed (round 1): it is gone.
    expect([l.class, l.severity, l.words]).toEqual(['missing', 'high', "This hook's program is gone: every transfer fails."]);
  });

  it('F-S3: a program whose authority was handed to its timelock address without a register (nobody can sign: frozen) is labelled author-upgradeable', () => {
    const program = k();
    const p = Buffer.alloc(36);
    p.writeUInt32LE(2, 0);
    a.programDataAddress(program).toBuffer().copy(p, 4);
    const pd = Buffer.alloc(45 + 8, 1);
    pd.writeUInt32LE(3, 0);
    pd.writeBigUInt64LE(5n, 4);
    pd[12] = 1;
    timelockAddress(program).toBuffer().copy(pd, 13);
    const l = riskLabelOf({ programId: program, program: { owner: a.BPF_LOADER_UPGRADEABLE, data: p, executable: true }, programdata: { owner: a.BPF_LOADER_UPGRADEABLE, data: pd, executable: false }, timelock: null, timelockProgramdata: null, status: null, attestation: null }, 0);
    // Round 1 read it as frozen (immutable); since the independent audit (finding 8) it reads as what
    // the launchpad and the companion make of it: refused.
    expect([l.class, l.severity, l.words]).toEqual(['author', 'high', 'Bordrless refuses this hook: its upgrade key was handed to a timelock address that was never set up.']);
  });

  it('F-S4: every hookRiskLabel call downloads the whole ProgramData and hook_timelock’s whole ProgramData, whatever `hash` says', async () => {
    const program = k();
    const asked: PublicKey[][] = [];
    const sliced: string[] = [];
    let whole = 0;
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[], config?: unknown) => {
        asked.push(keys);
        if (typeof config === 'object' && config !== null && 'dataSlice' in config) sliced.push(...keys.map(String));
        return keys.map(() => null);
      },
      getAccountInfo: async () => {
        whole += 1;
        return null;
      },
    } as unknown as Connection;
    await hookRiskLabel(connection, program, { hash: 'never' });
    // Fixed (round 1): the program and both ProgramData accounts are read as their 48-byte headers; nothing in full.
    expect(sliced.sort()).toEqual([program, a.programDataAddress(program), a.programDataAddress(a.HOOK_TIMELOCK_PROGRAM)].map(String).sort());
    expect(whole).toBe(0);
    expect(asked.flat().map(String)).toContain(timelockAddress(program).toBase58());
  });
});

describe('independent audit X5: a hook is as changeable as the programs it can call', () => {
  const immutableV4 = (code: Buffer): AccountInfo<Buffer> => {
    const acc = v4Program(k(), code);
    acc.data.writeBigUInt64LE(2n, 40);
    return acc;
  };
  it('a callee that its owner can upgrade makes the label author, high, and says so', () => {
    const hook = k();
    const pdA = Buffer.alloc(45);
    pdA.writeUInt32LE(3, 0);
    const p = Buffer.alloc(36);
    p.writeUInt32LE(2, 0);
    a.programDataAddress(hook).toBuffer().copy(p, 4);
    const acc = { programId: hook, program: { owner: a.BPF_LOADER_UPGRADEABLE, data: p, executable: true }, programdata: { owner: a.BPF_LOADER_UPGRADEABLE, data: pdA, executable: false }, timelock: null, timelockProgramdata: null, status: null, attestation: null };
    const alone = riskLabelOf(acc, 0);
    expect([alone.class, alone.severity]).toEqual(['immutable', 'medium']);
    const proxy = k();
    const l = riskLabelOf(acc, 0, null, [{ program: proxy, class: 'author' }]);
    expect([l.class, l.severity]).toEqual(['author', 'high']);
    expect(l.words).toBe(`Nobody can change this code. Bordrless hasn't checked it. It can call ${proxy.toBase58().slice(0, 8)}…, whose owner can change it at any time.`);
    expect(l.callees.map((c) => c.class)).toEqual(['author']);
    // A timelocked callee: the class drops to timelocked, medium; an immutable one changes nothing.
    const t = riskLabelOf(acc, 0, null, [{ program: k(), class: 'immutable' }, { program: proxy, class: 'timelocked' }]);
    expect([t.class, t.severity]).toEqual(['timelocked', 'medium']);
    expect(t.words).toMatch(/whose author can change it after a public delay\.$/);
    const i = riskLabelOf(acc, 0, null, [{ program: k(), class: 'immutable' }]);
    expect([i.class, i.severity, i.words]).toEqual([alone.class, alone.severity, alone.words]);
  });
  it('hookCallees reads the registry for the mint and classes its executable fixed keys, Bordrless’s own left out', async () => {
    const hook = k();
    const mint = k();
    const [author, wallet] = [k(), k()];
    const authorProgram = v4Program(author, Buffer.from('proxy code'));
    const fixedProgram = immutableV4(Buffer.from('fixed code'));
    const [authorKey, fixedKey] = [k(), k()];
    const registry = encodeHookAccountList({
      version: 1,
      accounts: [
        { writable: false, source: { kind: 'key', key: authorKey } },
        { writable: false, source: { kind: 'key', key: fixedKey } },
        { writable: false, source: { kind: 'key', key: wallet } },
        { writable: false, source: { kind: 'key', key: a.TOKEN_PROGRAM } },
        { writable: false, source: { kind: 'key', key: hook } },
      ],
    });
    const accounts = new Map<string, AccountInfo<Buffer>>([
      [a.registryAddress(hook, mint).toBase58(), { owner: hook, data: registry, executable: false, lamports: 1, rentEpoch: 0 }],
      [authorKey.toBase58(), authorProgram],
      [fixedKey.toBase58(), fixedProgram],
      [wallet.toBase58(), { owner: a.SYSTEM_PROGRAM, data: Buffer.alloc(0), executable: false, lamports: 1, rentEpoch: 0 }],
      [a.TOKEN_PROGRAM.toBase58(), { owner: a.BPF_LOADER_UPGRADEABLE, data: Buffer.alloc(36), executable: true, lamports: 1, rentEpoch: 0 }],
    ]);
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((x) => accounts.get(x.toBase58()) ?? null),
      getAccountInfo: async (x: PublicKey) => accounts.get(x.toBase58()) ?? null,
    } as unknown as Connection;
    const callees = await hookCallees(connection, hook, mint);
    expect(callees.map((c) => [c.program.toBase58(), c.class])).toEqual([
      [authorKey.toBase58(), 'author'],
      [fixedKey.toBase58(), 'immutable'],
    ]);
    expect(calleeExempt(hook, a.TOKEN_PROGRAM) && calleeExempt(hook, hook) && !calleeExempt(hook, authorKey)).toBe(true);
    // No registry for the mint: no callees.
    expect(await hookCallees(connection, hook, k())).toEqual([]);
  });
});
