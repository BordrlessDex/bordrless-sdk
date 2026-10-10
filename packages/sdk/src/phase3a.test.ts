/**
 * Phase 3a held to the Rust reference, byte for byte: `vectors/timelock.json`,
 * `vectors/strategy.json` and `vectors/risk-labels.json`, which bordrless-programs'
 * `phase3a_vectors.rs` renders from `hook_timelock::client`, `bordrless_companion::client`, the new
 * accounts, the strategy interface and the reference risk labels.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import timelockVectors from '../vectors/timelock.json' with { type: 'json' };
import strategyVectors from '../vectors/strategy.json' with { type: 'json' };
import riskVectors from '../vectors/risk-labels.json' with { type: 'json' };
import * as a from './addresses.ts';
import { classifyProgram, decodeTimelock, executableHash, timelockAddress, trimmedLength, TIMELOCK_OFFSETS } from './authority.ts';
import { STRATEGY_LIMITS, attestationAddress, companion, decodeHookAttestation, decodeHookStatus, decodeStrategyTerms, strategyArgsProblem, strategyRegistryAddress, strategyTermsAddress, type GameArgs, type StrategyArgs } from './companion.ts';
import { BORDRLESS_HOOKS, riskLabelOf, type RawAccount, type RiskAccounts } from './risk.ts';
import { ENTITLE_DISCRIMINATOR, PLAN_DISCRIMINATOR, decodeAnswer, encodeAnswer, encodeEntitleArgs, encodePlanArgs, entitleArgsOf, planArgsOf, poolReserves } from './strategy.ts';
import { loader, timelock } from './timelock.ts';

const key = (s: string): PublicKey => new PublicKey(s);
const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const asVector = (name: string, ix: TransactionInstruction) => ({
  name,
  program: ix.programId.toBase58(),
  accounts: ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]),
  data: ix.data.toString('hex'),
});
const byName = (list: { name: string }[], name: string) => {
  const v = list.find((x) => x.name === name);
  if (!v) throw new Error(`no vector ${name}`);
  return v;
};

describe('hook_timelock builders are the Rust client’s', () => {
  const k = timelockVectors.keys;
  const [payer, authority, program, author, buffer, sender, newAuthor] = [key(k.payer), key(k.authority), key(k.program), key(k.author), key(k.buffer), key(k.sender), key(k.newAuthor)] as const;
  const ours: Record<string, TransactionInstruction> = {
    register: timelock.register(payer, authority, program, 3 * 86_400, author),
    propose: timelock.propose(author, program, buffer, 207_681),
    cancel: timelock.cancel(author, program, buffer),
    execute: timelock.execute(sender, program, buffer, author),
    expire: timelock.expire(sender, program, buffer, author),
    reclaimBuffer: timelock.reclaimBuffer(author, program, buffer),
    lengthen: timelock.lengthen(author, program, 30 * 86_400),
    proposeAuthor: timelock.proposeAuthor(author, program, newAuthor),
    acceptAuthor: timelock.acceptAuthor(newAuthor, program),
    finalize: timelock.finalize(author, program),
    loaderSetAuthority: loader.setAuthority(buffer, author, timelockAddress(program)),
    loaderExtendProgram: loader.extendProgram(a.programDataAddress(program), program, payer, 10_240),
  };
  for (const [name, ix] of Object.entries(ours)) {
    it(name, () => expect(asVector(name, ix)).toEqual(byName(timelockVectors.instructions, name)));
  }
  it('derives the addresses and reads the account', () => {
    const c = timelockVectors.constants;
    expect(a.HOOK_TIMELOCK_PROGRAM.toBase58()).toBe(c.programId);
    expect(timelockAddress(program).toBase58()).toBe(c.timelockAddress);
    expect(TIMELOCK_OFFSETS.len).toBe(c.timelockLen);
    for (const v of timelockVectors.accounts) {
      const t = decodeTimelock(hex(v.data));
      expect(t).not.toBeNull();
      expect(t?.program.toBase58()).toBe(k.program);
      expect(t?.author.toBase58()).toBe(k.author);
      expect(t?.delaySecs).toBe(5 * 86_400);
      expect(t?.pending !== null).toBe(v.pending);
      if (v.pending) expect([t?.pending?.hash, t?.pending?.len, t?.pending?.eta]).toEqual(['ab'.repeat(32), 123_456, 1_800_432_000]);
    }
  });
});

describe('the companion’s phase-3a builders are the Rust client’s', () => {
  const k = strategyVectors.keys;
  const [payer, mint, hook, strategy, cranker, pool, ownerA, ownerB, authority, studioHook] = [key(k.payer), key(k.mint), key(k.hook), key(k.strategy), key(k.cranker), key(k.pool), key(k.ownerA), key(k.ownerB), key(k.authority), key(k.studioHook)] as const;
  const extras = k.extras.map(key);
  const split = { buybackBps: 3_000, holdersBps: 0, beneficiaryBps: 0 };
  const gameArgs = (h: PublicKey): GameArgs => ({ kind: 'strategy', hook: h, split, potBps: 7_000, roundSecs: 3_600, minPot: 100_000_000n, prizeBps: 0, claimWindowSecs: 600, maxAttempts: 0 });
  const s: StrategyArgs = { strategy, budgetBps: 5_000, maxShareBps: 2_500, maxPerTx: 4, planCuMax: 150_000, entitleCuMax: 60_000, minWeight: 1_000n };
  const attestArgs = { buildHash: '11'.repeat(32), sourceHash: '22'.repeat(32), templateCommit: '33'.repeat(20), simVersion: 3, simPass: true, cutMaxBps: 250, capBps: 500, review: 'warn' as const, kind: 'strategy' as const };
  const ours: Record<string, TransactionInstruction> = {
    createStrategyGame: companion.createStrategyGame(payer, mint, gameArgs(hook), s, [], false, extras),
    createStrategyGameTimelocked: companion.createStrategyGame(payer, mint, gameArgs(studioHook), s, companion.vettingAccounts(studioHook, false), true, extras.slice(0, 1)),
    planPeriod: companion.planPeriod(cranker, mint, hook, strategy, pool, extras, 500_123),
    payStrategy: companion.payStrategy(cranker, mint, hook, strategy, extras, 500_123, [ownerA, ownerB]),
    attest: companion.attest(key(strategyVectors.constants.studioAttester), studioHook, attestArgs),
    revoke: companion.revoke(authority, studioHook),
    setHookStatusV2: companion.setHookStatusV2(authority, studioHook, { audited: true, potCap: 0n, blocked: false }, '44'.repeat(32)),
    setHookStatusChecked: companion.setHookStatusChecked(authority, studioHook, { audited: false, potCap: 1_000_000_000n, blocked: true }),
    createGameV2Attested: companion.createGameV2Attested(payer, mint, { kind: 'streak', hook: studioHook, split, potBps: 7_000, roundSecs: 86_400, minPot: 100_000_000n, prizeBps: 10_000, claimWindowSecs: 3_600, maxAttempts: 0 }, { timerSecs: 0, minTokens: 0n, minStreakSecs: 3_600, minWeight: 1n }, true),
    createGameAttested: companion.createGameAttested(payer, mint, { kind: 'lottery', hook: studioHook, split, potBps: 7_000, roundSecs: 3_600, minPot: 100_000_000n, prizeBps: 10_000, claimWindowSecs: 300, maxAttempts: 6 }, false),
  };
  for (const [name, ix] of Object.entries(ours)) {
    it(name, () => expect(asVector(name, ix)).toEqual(byName(strategyVectors.instructions, name)));
  }
  it('reads the new accounts', () => {
    const acc = strategyVectors.accounts;
    expect(strategyTermsAddress(mint).toBase58()).toBe(acc.strategyTerms.address);
    const t = decodeStrategyTerms(hex(acc.strategyTerms.data));
    expect([t.strategy.toBase58(), t.extras.map(String), t.budgetBps, t.maxShareBps, t.maxPerTx, t.periodsPlanned, t.paidTotal, t.paidAtActive, t.auditOk, t.auditSlot]).toEqual([k.strategy, k.extras, 5_000, 2_500, 4, 7, 12_345_678_901n, 2_000_000n, true, 4_242n]);
    expect(attestationAddress(studioHook).toBase58()).toBe(acc.attestation.address);
    const at = decodeHookAttestation(hex(acc.attestation.data));
    expect([at.buildHash, at.templateCommit, at.review, at.kind, at.programdataSlot, at.attester.toBase58(), at.revoked]).toEqual(['11'.repeat(32), '33'.repeat(20), 'warn', 'strategy', 400_000_123n, strategyVectors.constants.studioAttester, false]);
    expect(decodeHookStatus(hex(acc.hookStatusWithHash.data)).auditedHash).toBe('55'.repeat(32));
    expect(strategyRegistryAddress(strategy, mint).toBase58()).toBe(strategyVectors.interface.registryAddress);
    const c = strategyVectors.constants;
    expect([STRATEGY_LIMITS.maxBudgetBps, STRATEGY_LIMITS.maxShareBps, STRATEGY_LIMITS.maxPerTx, STRATEGY_LIMITS.maxPlanCu, STRATEGY_LIMITS.maxEntitleCu]).toEqual([c.maxBudgetBps, c.maxShareBps, c.maxPerTx, c.maxPlanCu, c.maxEntitleCu]);
    expect(a.HOOK_TIMELOCK_PROGRAM.toBase58()).toBe(c.hookTimelockId);
  });
  it('encodes the strategy interface as the crate does', () => {
    const i = strategyVectors.interface;
    expect(PLAN_DISCRIMINATOR.toString('hex')).toBe(i.plan);
    expect(ENTITLE_DISCRIMINATOR.toString('hex')).toBe(i.entitle);
    expect(encodePlanArgs({ mint, period: 500_123, periodStart: 1_800_442_800, periodEnd: 1_800_446_400, total: 9_876_543_210n, pot: 4_000_000_000n, budgetMax: 2_000_000_000n, periodsPlanned: 3, paidTotal: 5_555_555n, now: 1_800_446_410 }).toString('hex')).toBe(i.planArgs);
    expect(encodeEntitleArgs({ mint, period: 500_123, owner: ownerA, balance: 1_000_000_000n, weight: 900_000_000n, since: 1_800_000_000, total: 9_876_543_210n, budget: 2_000_000_000n, paid: 100n, maxAmount: 500_000_000n, now: 1_800_446_420 }).toString('hex')).toBe(i.entitleArgs);
    expect(encodeAnswer(1_234_567n).toString('hex')).toBe(i.planDecision);
    expect(decodeAnswer(hex(i.entitlement))).toBe(7_654_321n);
    expect(decodeAnswer(new Uint8Array(7))).toBeNull();
    // The companion's arguments: the budget bound and the per-holder bound.
    expect(planArgsOf({ mint, period: 1, roundSecs: 3_600, total: 10n, pot: 1_000n, budgetBps: 5_000, periodsPlanned: 0, paidTotal: 0n, now: 7_300 }).budgetMax).toBe(500n);
    expect(entitleArgsOf({ mint, period: 1, owner: ownerA, balance: 5n, weight: 5n, since: 0, total: 10n, budget: 1_000n, paid: 900n, maxShareBps: 2_500, now: 0 }).maxAmount).toBe(100n);
    expect(poolReserves(Buffer.alloc(10))).toBeNull();
  });
  it('checks the terms as the program does', () => {
    expect(strategyArgsProblem(gameArgs(hook), s)).toBeNull();
    expect(strategyArgsProblem(gameArgs(hook), { ...s, budgetBps: 5_001 })).toMatch(/half/);
    expect(strategyArgsProblem(gameArgs(hook), { ...s, maxShareBps: 2_501 })).toMatch(/quarter/);
    expect(strategyArgsProblem({ ...gameArgs(hook), prizeBps: 10 }, s)).toMatch(/prize/);
  });
});

describe('risk labels are the Rust reference’s', () => {
  const rawOf = (r: { owner: string; executable: boolean; data: string } | null): RawAccount | null => (r ? { owner: key(r.owner), executable: r.executable, data: hex(r.data) } : null);
  for (const c of riskVectors.cases) {
    it(c.name, () => {
      const acc: RiskAccounts = {
        programId: key(c.accounts.programId),
        program: rawOf(c.accounts.program),
        programdata: rawOf(c.accounts.programdata),
        timelock: rawOf(c.accounts.timelock),
        timelockProgramdata: rawOf(c.accounts.timelockProgramdata),
        status: rawOf(c.accounts.status),
        attestation: rawOf(c.accounts.attestation),
      };
      const l = riskLabelOf(acc, c.now, c.executableHash);
      const want = c.label;
      expect({
        class: l.class,
        delaySecs: l.delaySecs,
        author: l.author?.toBase58() ?? null,
        pending: l.pending ? { hash: l.pending.hash, eta: l.pending.eta, buffer: l.pending.buffer.toBase58() } : null,
        timelockProgramUpgradeable: l.timelockProgramUpgradeable,
        audited: l.audited === false ? 'false' : l.audited,
        blocked: l.blocked,
        potCap: l.potCap === null ? null : l.potCap.toString(),
        provenance: l.provenance,
        studio: l.studio,
        severity: l.severity,
        words: l.words,
      }).toEqual(want);
    });
  }
  it('names the protocol’s own hooks', () => {
    expect(BORDRLESS_HOOKS.map(String)).toEqual(riskVectors.constants.bordrlessHooks);
  });
});

describe('authority helpers', () => {
  it('hashes code as solana-verify does and classes by the loader', () => {
    expect(trimmedLength(Uint8Array.from([1, 2, 0, 0]))).toBe(2);
    expect(executableHash(Uint8Array.from([1, 2, 0, 0]))).toBe(executableHash(Uint8Array.from([1, 2])));
    const program = PublicKey.unique();
    expect(classifyProgram(program, { owner: new PublicKey('BPFLoader2111111111111111111111111111111111'), data: Buffer.alloc(0) }, null, null)).toEqual({ kind: 'immutable' });
    expect(classifyProgram(program, { owner: a.BPF_LOADER_UPGRADEABLE, data: Buffer.alloc(36) }, null, null)).toBe('wrongProgramData');
  });
});
