/**
 * The rules lane from a terminal (rules.ts, docs/rules-lane.md §4): the builder makes the doc's
 * examples byte for byte as `vectors/rules.json` has them and refuses what the engine refuses; the
 * instructions have the engine's accounts and data; the three layouts decode at their offsets; a
 * composed config is `create_config` (or the listed one) and `bind` on the same keypair; the
 * starter spells the rules out in Rust.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AUTHOR_SHARE_BPS, HOOK_DATA_LEN, RULES_ENGINE_ERRORS, RULES_HOOK, RULES_HOOK_PROGRAM, RULES_HOOK_PROGRAM_ID_MAINNET, RULES_REFUSAL_ERRORS, RULES_REFUSAL_TEXT, RulesError, decodeRules, encodeRules, rulesFlagsOf, rulesFromHex, rulesToHex, type RuleSet } from '@bordrless/shared';
import vectors from '../../shared/vectors/rules.json' with { type: 'json' };
import { BRIDGED_SOL_MINT, LAUNCH_CONFIG, LAUNCH_PROGRAM, RULES_ENGINE_HOOK_AUTHORITY, RULES_ENGINE_PROGRAM, SYSTEM_PROGRAM, TOKEN_HOOK_SIGNER_RULES, holdingAddress, launchAddress, launchPoolAddress, registryAddress } from './addresses.ts';
import { CODERS, IDL } from './coders.ts';
import { explainProgramError } from './errors.ts';
import { logEventsOf } from './events.ts';
import {
  BIND_DISCRIMINATOR,
  RULES_HOLDING_LAYOUT,
  RULES_HOOK_KEY,
  RULES_STATE_LAYOUT,
  RULE_SET_LAYOUT,
  bindData,
  bindKeys,
  buildCreateComposedConfig,
  decodeRuleSetAccount,
  decodeRulesHolding,
  decodeRulesState,
  destinationWalletFor,
  prepareData,
  prepareKeys,
  ruleSetAddress,
  rules,
  rulesDestinationHolding,
  rulesHookExtras,
  rulesHook,
  rulesStateAddress,
  rustAtom,
  rustRule,
} from './rules.ts';
import { PREPARE_DISCRIMINATOR, hookStateAddress } from './template.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const vector = (id: string) => vectors.cases.find((c) => c.id === id)!;

/** The doc's examples through the builder (§4's sample). */
const EXAMPLES: Record<string, () => RuleSet> = {
  'loss-shield': () =>
    rules
      .compose({ keeps: ['entry'], destination: 'burn' })
      .rule({ on: ['sell'], when: [rules.gain.gt(0)], then: rules.cut(500) })
      .build(),
  cooldown: () =>
    rules
      .compose({ keeps: ['times'] })
      .rule({ on: ['sell', 'send'], when: [rules.sinceReceived.lt(3600)], then: rules.refuse('cooling') })
      .build(),
  'whale-tax': () =>
    rules
      .compose({ destination: 'creator' })
      .rule({ on: ['sell'], when: [rules.valueBefore.gt(6_500_000_000n)], then: rules.cut(300) })
      .build(),
  'whale-cap': () =>
    rules
      .compose()
      .rule({ on: ['buy', 'receive'], when: [rules.shareAfter.gt(200)], unless: rules.graduated, then: rules.refuse('cap') })
      .build(),
  'early-sell-penalty': () =>
    rules
      .compose({ keeps: ['times'], destination: 'burn' })
      .rule({ on: ['sell'], when: [rules.sinceLaunch.lt(86_400)], then: rules.cut(1000) })
      .rule({ on: ['sell', 'send'], when: [rules.sinceReceived.lt(600)], then: rules.refuse('cooling') })
      .build(),
  'early-lock': () =>
    rules
      .compose({ keeps: ['times'] })
      .rule({ on: ['sell', 'send'], when: [rules.sinceLaunch.lt(3600), rules.firstAfterLaunch.lt(60)], then: rules.refuse('locked') })
      .build(),
  'lossback-shield': () =>
    rules
      .compose({ keeps: ['entry'], destination: 'burn', entryCapBps: 2_000 })
      .rule({ on: ['sell'], when: [rules.gain.gt(0)], then: rules.cut(500) })
      .build(),
  'counter-and-mark': () =>
    rules
      .compose({ keeps: ['count', 'times'] })
      .rule({ on: ['sell'], then: rules.count() })
      .rule({ on: ['sell'], when: [rules.counter.ge(3), rules.sinceReceived.lt(86_400)], then: rules.refuse() })
      .rule({ on: ['buy'], when: [rules.amount.gt(1_000_000_000_000n)], then: rules.mark(0) })
      .build(),
};

describe('the builder', () => {
  for (const [id, make] of Object.entries(EXAMPLES)) {
    it(`makes ${id} byte for byte as the vectors have it, and reads it the same`, () => {
      const set = make();
      expect(rulesToHex(rules.encode(set))).toBe(vector(id).bytes);
      expect(rules.decode(rulesFromHex(vector(id).bytes))).toEqual(set);
      expect(rules.render(set, { symbol: vector(id).symbol ?? null }).sentences).toEqual(vector(id).sentences);
      expect(rules.flagsFor(set)).toBe(vector(id).flags);
      expect(rules.validate(set)).toEqual([]);
    });
  }

  it('throws the engine’s refusal by code, with the rule, and keeps the unchecked set readable', () => {
    const c = rules.compose({ destination: 'burn' }).rule({ on: ['sell'], when: [rules.gain.gt(0)], then: rules.cut(500) });
    expect(() => c.build()).toThrow(RulesError);
    try {
      c.build();
    } catch (e) {
      expect(e).toMatchObject({ code: 'keeps_entry', rule: 0 });
      expect((e as Error).message).toBe('Rule 1: A condition on gain, loss or the entry price needs the set to keep an entry price.');
    }
    expect(c.set().rules).toHaveLength(1);
    expect(() => rules.compose().build()).toThrow(/1 to 6 rules/);
    expect(() => rules.compose({ destination: 'burn' }).rule({ on: ['sell', 'burn'], then: rules.cut(1) }).build()).toThrow(/burn/);
    expect(() => rules.compose({ destination: 'burn' }).rule({ on: ['sell'], then: rules.cut(1_501) }).build()).toThrow(/1 to 1,500/);
    expect(() => rules.compose().rule({ on: ['sell'], then: rules.refuse() }).build()).toThrow(/at least one condition/);
    expect(() => rules.compose({ keeps: ['count'] }).rule({ on: ['sell'], when: [rules.marked()], then: rules.refuse() }).build()).toThrow(/not on a mark or the count alone/);
    expect(() => rules.compose({ keeps: ['entry'], destination: 'burn' }).rule({ on: ['sell'], when: [rules.gain.ge(10_001)], then: rules.cut(1) }).build()).toThrow(/within its unit/);
  });

  it('offers every value, the booleans and the four actions', () => {
    expect(rules.flag(2).eq(1)).toEqual({ value: 'flag2', op: 'eq', literal: 1n });
    expect(rules.marked(3)).toEqual({ value: 'flag3', op: 'eq', literal: 1n });
    expect(rules.notGraduated).toEqual({ value: 'graduated', op: 'eq', literal: 0n });
    expect(rules.hasEntry).toEqual({ value: 'hasEntry', op: 'eq', literal: 1n });
    expect(rules.noEntry).toEqual({ value: 'hasEntry', op: 'eq', literal: 0n });
    expect(rules.tradePrice.le(5)).toEqual({ value: 'tradePrice', op: 'le', literal: 5n });
    expect(rules.cut(5)).toEqual({ kind: 'cut', bps: 5 });
    expect(rules.refuse()).toEqual({ kind: 'refuse', reason: 'rule' });
    expect(rules.count('reset')).toEqual({ kind: 'count', what: 'reset' });
    expect(rules.mark(1, false)).toEqual({ kind: 'flag', flag: 1, set: false });
    expect(rules.limits.rules).toBe(6);
    expect(rules.reading(EXAMPLES['loss-shield']!(), { name: 'Loss shield' }).reading.does).toBe(vector('loss-shield').sentences.join(' '));
  });
});

describe('the engine’s addresses and instructions', () => {
  it('builds for the engine’s own id, the lane open since its deploy, and derives the RuleSet and the state under it', () => {
    expect(RULES_HOOK_KEY.toBase58()).toBe(RULES_HOOK_PROGRAM_ID_MAINNET);
    expect(RULES_HOOK_KEY.toBase58()).toBe('AfDhsethmkoimbyoSWnRfLtjFXZteRNtbFMioR9qWMjD');
    expect(RULES_HOOK_KEY.equals(RULES_ENGINE_PROGRAM)).toBe(true);
    // The lane's switch: the engine's id since its deploy (13 Oct).
    expect(RULES_HOOK_PROGRAM).toBe(RULES_HOOK_PROGRAM_ID_MAINNET);
    expect(RULES_HOOK.deployed).toBe(true);
    expect(RULES_HOOK.programId).toBe(RULES_HOOK_PROGRAM_ID_MAINNET);
    expect([TOKEN_HOOK_SIGNER_RULES.toBase58(), RULES_ENGINE_HOOK_AUTHORITY.toBase58()]).toEqual([RULES_HOOK.tokenHookSigner, RULES_HOOK.hookAuthority]);
    expect(PublicKey.findProgramAddressSync([Buffer.from('hook-authority')], RULES_HOOK_KEY)[1]).toBe(RULES_HOOK.hookAuthorityBump);
    const config = k();
    expect(ruleSetAddress(config).equals(PublicKey.findProgramAddressSync([Buffer.from('rules'), config.toBuffer()], RULES_HOOK_KEY)[0])).toBe(true);
    const mint = k();
    expect(rulesStateAddress(mint).equals(hookStateAddress(RULES_HOOK_KEY, mint))).toBe(true);
    const engine = k();
    expect(ruleSetAddress(config, engine).equals(PublicKey.findProgramAddressSync([Buffer.from('rules'), config.toBuffer()], engine)[0])).toBe(true);
  });

  it('bind: Anchor’s discriminator, the bytes behind a u32, the destination and the wallet; payer, config, RuleSet, system', () => {
    expect(BIND_DISCRIMINATOR.toString('hex')).toBe(createHash('sha256').update('global:bind').digest().subarray(0, 8).toString('hex'));
    const set = EXAMPLES['whale-tax']!();
    const [payer, config, engine] = [k(), k(), k()];
    const ix = rulesHook.bind(payer, config, set, null, engine);
    expect(ix.programId.equals(engine)).toBe(true);
    expect(ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual([
      [payer.toBase58(), true, true],
      [config.toBase58(), false, false],
      [ruleSetAddress(config, engine).toBase58(), false, true],
      [SYSTEM_PROGRAM.toBase58(), false, false],
    ]);
    const bytes = encodeRules(set);
    expect(ix.data.subarray(0, 8).equals(BIND_DISCRIMINATOR)).toBe(true);
    expect(ix.data.readUInt32LE(8)).toBe(bytes.length);
    expect(ix.data.subarray(12, 12 + bytes.length).equals(Buffer.from(bytes))).toBe(true);
    expect(ix.data[12 + bytes.length]).toBe(2);
    expect(ix.data.subarray(13 + bytes.length).equals(PublicKey.default.toBuffer())).toBe(true);
    expect(ix.data.length).toBe(8 + 4 + bytes.length + 1 + 32);
    expect(bindData(bytes, 2, PublicKey.default).equals(ix.data)).toBe(true);
    // A refused set never becomes an instruction.
    expect(() => rulesHook.bind(payer, config, { ...set, rules: [] })).toThrow(RulesError);
  });

  it('bind: a named destination carries its wallet, on the curve and not the default key', () => {
    const wallet = k();
    const set = rules
      .compose({ destination: 'named' })
      .rule({ on: ['sell'], then: rules.cut(100) })
      .build();
    const ix = rulesHook.bind(k(), k(), set, wallet);
    expect(ix.data.subarray(ix.data.length - 32).equals(wallet.toBuffer())).toBe(true);
    expect(ix.data[ix.data.length - 33]).toBe(3);
    expect(() => rulesHook.bind(k(), k(), set, null)).toThrow(/named destination/);
    expect(() => rulesHook.bind(k(), k(), set, PublicKey.default)).toThrow(RulesError);
    expect(() => destinationWalletFor(set, launchAddress(k()))).toThrow(/on the curve/);
    expect(destinationWalletFor({ destination: 'burn' }, null).equals(PublicKey.default)).toBe(true);
  });

  it('prepare: the template’s five accounts and the RuleSet, no arguments', () => {
    const [payer, mint, config, engine] = [k(), k(), k(), k()];
    const ix = rulesHook.prepare(payer, mint, config, engine);
    expect(ix.programId.equals(engine)).toBe(true);
    expect(ix.data.equals(PREPARE_DISCRIMINATOR)).toBe(true);
    expect(ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual([
      [payer.toBase58(), true, true],
      [mint.toBase58(), false, false],
      [hookStateAddress(engine, mint).toBase58(), false, true],
      [registryAddress(engine, mint).toBase58(), false, true],
      [SYSTEM_PROGRAM.toBase58(), false, false],
      [ruleSetAddress(config, engine).toBase58(), false, false],
    ]);
  });

  it('names where the cuts go for a mint', () => {
    const [mint, me, wallet] = [k(), k(), k()];
    expect(rulesDestinationHolding({ destination: 'burn' }, mint, me)!.equals(holdingAddress(mint, launchAddress(mint)))).toBe(true);
    expect(rulesDestinationHolding({ destination: 'creator' }, mint, me)!.equals(holdingAddress(mint, me))).toBe(true);
    expect(rulesDestinationHolding({ destination: 'named' }, mint, me, wallet)!.equals(holdingAddress(mint, wallet))).toBe(true);
    expect(rulesDestinationHolding({ destination: 'named' }, mint, me)).toBeNull();
    expect(rulesDestinationHolding({ destination: 'none' }, mint, me)).toBeNull();
  });
});

describe('buildCreateComposedConfig', () => {
  const me = k();
  const set = EXAMPLES['loss-shield']!();

  it('is create_config naming the engine with the set’s flags, no kit rules, then bind, on one keypair', () => {
    const keypair = Keypair.generate();
    const made = buildCreateComposedConfig(me, { label: 'Loss shield', creatorFeeBps: 100 }, set, null, keypair);
    expect(made.address.equals(keypair.publicKey)).toBe(true);
    expect(made.instructions).toEqual([made.instruction, made.bind]);
    expect(made.flags).toBe(209);
    expect(made.bytes).toBe(vector('loss-shield').bytes);
    expect(made.ruleSet.equals(ruleSetAddress(keypair.publicKey))).toBe(true);
    expect(made.instruction.programId.equals(LAUNCH_PROGRAM)).toBe(true);
    const decoded = CODERS.launch.instruction.decode(made.instruction.data) as { name: string; data: { args: { creatorFeeBps: number; customHook: PublicKey | null; customHookFlags: number; label: string; rules: Record<string, number> }; authorShareBps?: number } };
    expect(decoded.name).toBe('createConfig');
    expect(decoded.data.args.customHook!.equals(RULES_HOOK_KEY)).toBe(true);
    expect(decoded.data.args.customHookFlags).toBe(209);
    expect(decoded.data.args.creatorFeeBps).toBe(100);
    expect(decoded.data.args.label).toBe('Loss shield');
    expect(Object.values(decoded.data.args.rules).every((v) => v === 0)).toBe(true);
    expect(made.instruction.keys.map((m) => m.pubkey.toBase58()).slice(0, 4)).toEqual([me.toBase58(), LAUNCH_CONFIG.toBase58(), keypair.publicKey.toBase58(), RULES_HOOK_KEY.toBase58()]);
    expect(made.bind.keys[1]!.pubkey.equals(keypair.publicKey)).toBe(true);
    expect(made.bind.keys[0]!.pubkey.equals(me)).toBe(true);
  });

  it('is create_listed_config with the Workshop’s share when listed, or with the share given; carries the burn rows', () => {
    const listed = buildCreateComposedConfig(me, { label: 'Loss shield', creatorFeeBps: 100, listed: true, burnBuyBps: 25, burnSellBps: 50 }, set);
    const decoded = CODERS.launch.instruction.decode(listed.instruction.data) as { name: string; data: { args: { rules: { burnBuyBps: number; burnSellBps: number } }; authorShareBps: number } };
    expect(decoded.name).toBe('createListedConfig');
    expect(decoded.data.authorShareBps).toBe(AUTHOR_SHARE_BPS);
    expect(decoded.data.args.rules).toMatchObject({ burnBuyBps: 25, burnSellBps: 50 });
    const shared = buildCreateComposedConfig(me, { label: 'x', creatorFeeBps: 50 }, set, 1_000);
    expect((CODERS.launch.instruction.decode(shared.instruction.data) as unknown as { data: { authorShareBps: number } }).data.authorShareBps).toBe(1_000);
  });

  it('refuses a set the engine would refuse, and a named destination without its wallet', () => {
    expect(() => buildCreateComposedConfig(me, { label: 'x', creatorFeeBps: 100 }, { ...set, keeps: { entry: false, times: false, count: false } })).toThrow(RulesError);
    const named = rules
      .compose({ destination: 'named' })
      .rule({ on: ['sell'], then: rules.cut(100) })
      .build();
    expect(() => buildCreateComposedConfig(me, { label: 'x', creatorFeeBps: 100 }, named)).toThrow(/named destination/);
    const wallet = k();
    const made = buildCreateComposedConfig(me, { label: 'x', creatorFeeBps: 100, destinationWallet: wallet }, named);
    expect(made.bind.data.subarray(made.bind.data.length - 32).equals(wallet.toBuffer())).toBe(true);
  });

  it('takes another engine id (a test validator’s) and derives everything under it', () => {
    const engine = k();
    const made = buildCreateComposedConfig(me, { label: 'x', creatorFeeBps: 100 }, set, null, Keypair.generate(), engine);
    expect(made.bind.programId.equals(engine)).toBe(true);
    expect(made.ruleSet.equals(ruleSetAddress(made.address, engine))).toBe(true);
    expect((CODERS.launch.instruction.decode(made.instruction.data) as unknown as { data: { args: { customHook: PublicKey } } }).data.args.customHook.equals(engine)).toBe(true);
  });
});

describe('the layouts', () => {
  it('RuleSet (§2.1): the fields at their offsets, 447 bytes', () => {
    expect(RULE_SET_LAYOUT).toMatchObject({ version: 8, bump: 9, config: 10, author: 42, boundAt: 74, destination: 82, destinationWallet: 83, flags: 115, hash: 117, len: 149, rules: 151, size: 447 });
    const set = EXAMPLES['whale-tax']!();
    const bytes = encodeRules(set);
    const [config, author, wallet] = [k(), k(), k()];
    const b = Buffer.alloc(RULE_SET_LAYOUT.size);
    b[8] = 1;
    b[9] = 254;
    config.toBuffer().copy(b, 10);
    author.toBuffer().copy(b, 42);
    b.writeBigInt64LE(1_700_000_000n, 74);
    b[82] = 2;
    wallet.toBuffer().copy(b, 83);
    b.writeUInt16LE(65, 115);
    createHash('sha256').update(bytes).digest().copy(b, 117);
    b.writeUInt16LE(bytes.length, 149);
    Buffer.from(bytes).copy(b, 151);
    const r = decodeRuleSetAccount(b);
    expect(r).toMatchObject({ version: 1, bump: 254, boundAt: 1_700_000_000, destination: 'creator', flags: 65 });
    expect(r.config.equals(config)).toBe(true);
    expect(r.author.equals(author)).toBe(true);
    expect(r.destinationWallet!.equals(wallet)).toBe(true);
    expect(r.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(rulesToHex(r.bytes)).toBe(vector('whale-tax').bytes);
    expect(r.set).toEqual(set);
    expect(rulesFlagsOf(r.set!)).toBe(r.flags);
    // A zero wallet reads as none; bytes that do not decode leave `set` null.
    PublicKey.default.toBuffer().copy(b, 83);
    b[151] = 9;
    expect(decodeRuleSetAccount(b)).toMatchObject({ destinationWallet: null, set: null });
    expect(() => decodeRuleSetAccount(b.subarray(0, 100))).toThrow(/447/);
  });

  it('the state (§2.2): 628 bytes, the fields at their offsets', () => {
    expect(RULES_STATE_LAYOUT).toMatchObject({ mint: 10, launch: 42, pool: 74, config: 106, ruleSet: 138, destinationHolding: 170, destinationOwner: 202, preparedBy: 234, preparedAt: 266, reference: 274, referenceAt: 282, paidTotal: 290, records: 298, flags: 306, rulesLen: 308, rules: 310, creatorBump: 606, reserved: 607, size: 628 });
    const set = EXAMPLES['cooldown']!();
    const bytes = encodeRules(set);
    const keys = Array.from({ length: 8 }, () => k());
    const b = Buffer.alloc(RULES_STATE_LAYOUT.size);
    b[8] = 1;
    b[9] = 250;
    keys.forEach((key, i) => key.toBuffer().copy(b, 10 + 32 * i));
    b.writeBigInt64LE(1_700_000_000n, 266);
    b.writeBigUInt64LE(123_456_789n, 274);
    b.writeBigInt64LE(1_700_000_600n, 282);
    b.writeBigUInt64LE(5_000n, 290);
    b.writeBigUInt64LE(3n, 298);
    b.writeUInt16LE(145, 306);
    b.writeUInt16LE(bytes.length, 308);
    Buffer.from(bytes).copy(b, 310);
    const s = decodeRulesState(b);
    expect(s).toMatchObject({ version: 1, bump: 250, preparedAt: 1_700_000_000, reference: 123_456_789n, referenceAt: 1_700_000_600, paidTotal: 5_000n, records: 3n, flags: 145 });
    expect([s.mint, s.launch, s.pool, s.config, s.ruleSet, s.destinationHolding, s.destinationOwner, s.preparedBy].map((x, i) => x.equals(keys[i]!))).toEqual(Array(8).fill(true));
    expect(s.set).toEqual(set);
    expect(() => decodeRulesState(b.subarray(0, 600))).toThrow(/628/);
  });

  it('the holding (§2.3): the Loss cover fields at their offsets, the engine’s after them; version 0 is no record', () => {
    expect(RULES_HOLDING_LAYOUT).toMatchObject({ version: 0, flags: 1, entry: 2, amount: 10, paid: 18, sentAt: 26, paidAt: 34, receivedAt: 42, round: 50, counter: 54, firstAt: 58, reserved: 62 });
    const b = Buffer.alloc(HOOK_DATA_LEN);
    expect(decodeRulesHolding(b)).toBeNull();
    b[0] = 1;
    b[1] = 1 | 2 | 16 | 128;
    b.writeBigUInt64LE(7_000_000_000n, 2);
    b.writeBigUInt64LE(1_000_000n, 10);
    b.writeBigUInt64LE(500n, 18);
    b.writeBigInt64LE(1_700_000_100n, 26);
    b.writeBigInt64LE(1_700_000_200n, 34);
    b.writeBigInt64LE(1_700_000_050n, 42);
    b.writeUInt32LE(4, 50);
    b.writeUInt32LE(9, 54);
    b.writeUInt32LE(60, 58);
    expect(decodeRulesHolding(b)).toEqual({ version: 1, sold: true, firstSet: true, marks: [true, false, false, true], entry: 7_000_000_000n, amount: 1_000_000n, paid: 500n, sentAt: 1_700_000_100, paidAt: 1_700_000_200, receivedAt: 1_700_000_050, round: 4, counter: 9, firstAt: 60 });
    expect(() => decodeRulesHolding(b.subarray(0, 10))).toThrow(/64/);
  });
});

describe('toStarter', () => {
  it('spells the rules out in Rust on the template, with the sentences, the flags and the engine’s holding layout', () => {
    const set = EXAMPLES['early-sell-penalty']!();
    const src = rules.toStarter(set);
    expect(src).toContain('//! Takes 10% of every sell in the first day after launch, burned.');
    expect(src).toContain('//! Flags for its config: 209 (BEFORE_TRANSFER | TRANSFER_RETURNS_DELTA | BEFORE_BURN | WRITES_HOOK_DATA).');
    expect(src).toContain('pub fn decide(side: u8, v: &Values) -> Decision');
    expect(src).toContain('if side & (SELL) != 0\n        && v.since_launch < 86_400\n    {\n        d.cut_bps += 1000;\n    }');
    expect(src).toContain('if side & (SELL | SEND) != 0\n        && v.since_received.map_or(false, |x| x < 600)\n    {\n        d.refuse = Some(HookError::CoolingDown);\n        return d;\n    }');
    expect(src).toContain('pub fn prepare(ctx: Context<Prepare>)');
    expect(src).toContain('pub fn before_transfer(ctx: Context<Callback>, args: TokenHookArgs) -> Result<HookReturn>');
    expect(src).toContain('data[42..50].copy_from_slice(&self.received_at.to_le_bytes());');
    expect(src).toContain('declare_id!("STUDIO_PROGRAM_ID");');
    expect(src).toContain(`Pubkey::from_str_const("${LAUNCH_PROGRAM.toBase58()}")`);
    // Burn: the launch's reserve holding, writable.
    expect(src).toContain('ExtraAccount { writable: true, source: AccountSource::Pda { program: TOKEN_PROGRAM, seeds: vec![Seed::Literal(b"holding".to_vec()), Seed::Account(1), Seed::Account(6)] } }');
  });

  it('writes each atom and action as Rust', () => {
    expect(rustAtom(rules.gain.gt(0))).toBe('v.gain.map_or(false, |x| x > 0)');
    expect(rustAtom(rules.sinceLaunch.lt(86_400))).toBe('v.since_launch < 86_400');
    expect(rustAtom(rules.amount.gt(1_000_000_000_000n))).toBe('v.amount > 1_000_000_000_000');
    expect(rustAtom(rules.graduated)).toBe('v.graduated');
    expect(rustAtom(rules.notGraduated)).toBe('!v.graduated');
    expect(rustAtom(rules.flag(2).ne(1))).toBe('!v.flags[2]');
    expect(rustAtom(rules.hasEntry)).toBe('v.has_entry');
    expect(rustRule({ on: ['buy', 'receive'], when: [rules.shareAfter.gt(200)], unless: rules.graduated, then: rules.refuse('cap'), stop: false }, 0)).toBe('    // rule 1\n    if side & (BUY | RECEIVE) != 0\n        && v.share_after > 200\n        && !(v.graduated)\n    {\n        d.refuse = Some(HookError::OverCap);\n        return d;\n    }');
    expect(rustRule({ on: ['sell'], when: [], unless: null, then: rules.count('reset'), stop: true }, 2)).toContain('d.count_reset = true;\n        return d;');
    expect(rustRule({ on: ['buy'], when: [], unless: null, then: rules.mark(3, false), stop: false }, 0)).toContain('d.marks[3] = Some(false);');
  });

  it('names the cut wallet for a creator or a named destination', () => {
    const wallet = k();
    const named = rules
      .compose({ destination: 'named' })
      .rule({ on: ['sell'], then: rules.cut(100) })
      .build();
    const src = rules.toStarter(named, { destinationWallet: wallet });
    expect(src).toContain(`Pubkey::from_str_const("${wallet.toBase58()}")`);
    expect(src).toContain('Seed::Literal(CUT_WALLET.to_bytes().to_vec())');
    expect(src).not.toContain('REPLACE with your own wallet');
    const creator = rules
      .compose({ destination: 'creator' })
      .rule({ on: ['sell'], then: rules.cut(100) })
      .build();
    expect(rules.toStarter(creator)).toContain('REPLACE with your own wallet');
    expect(rules.toStarter(creator)).toContain('paid to the creator');
  });
});

describe('the engine’s wire format, in one place until its IDL exists', () => {
  it('is what bind and prepare send: the data and the accounts in order', () => {
    const [payer, config, mint, engine] = [k(), k(), k(), k()];
    const set = rules.compose({ keeps: ['entry'], destination: 'burn' }).rule({ on: ['sell'], when: [rules.gain.gt(0)], then: rules.cut(500) }).build();
    const bind = rulesHook.bind(payer, config, set, null, engine);
    expect(bind.keys).toEqual(bindKeys(payer, config, engine));
    expect(bind.data).toEqual(bindData(encodeRules(set), 1, PublicKey.default));
    const prepare = rulesHook.prepare(payer, mint, config, engine);
    expect(prepare.keys).toEqual(prepareKeys(payer, mint, config, engine));
    expect(prepare.data).toEqual(prepareData());
    expect(prepareData()).toEqual(Buffer.from(PREPARE_DISCRIMINATOR));
    expect(prepareKeys(payer, mint, config, engine).map((m) => [m.isSigner, m.isWritable])).toEqual([[true, true], [false, false], [false, true], [false, true], [false, false], [false, false]]);
  });
});

describe('the vectors file is the shared one', () => {
  it('decodes every case the SDK way too', () => {
    for (const c of vectors.cases) expect(rulesToHex(encodeRules(decodeRules(rulesFromHex(c.bytes))))).toBe(c.bytes);
  });
});

describe('the engine’s IDL (idl/rules_hook.json)', () => {
  type RawAccount = { name: string; writable?: boolean; signer?: boolean };
  type RawIdl = { address: string; instructions: { name: string; discriminator: number[]; accounts: RawAccount[]; args: { name: string }[] }[]; errors: { code: number; name: string }[]; events: { name: string; discriminator: number[] }[] };
  const idl = IDL.rulesHook as unknown as RawIdl;
  const ixOf = (name: string) => idl.instructions.find((i) => i.name === name)!;
  const flagsOf = (accounts: RawAccount[]) => accounts.map((x) => [x.signer === true, x.writable === true]);

  it('is the engine’s, and bind and prepare are the SDK’s wire format', () => {
    expect(idl.address).toBe(RULES_HOOK_PROGRAM_ID_MAINNET);
    const [payer, config, mint, wallet] = [k(), k(), k(), k()];
    const bind = ixOf('bind');
    expect(Buffer.from(bind.discriminator).equals(BIND_DISCRIMINATOR)).toBe(true);
    expect(bind.args.map((x) => x.name)).toEqual(['rules', 'destination', 'wallet']);
    expect(bind.accounts.map((x) => x.name)).toEqual(['payer', 'launch_config', 'rule_set', 'system_program']);
    expect(flagsOf(bind.accounts)).toEqual(bindKeys(payer, config).map((m) => [m.isSigner, m.isWritable]));
    const bytes = encodeRules(EXAMPLES['whale-tax']!());
    expect(Buffer.from(CODERS.rulesHook.instruction.encode('bind', { rules: Buffer.from(bytes), destination: 2, wallet })).equals(bindData(bytes, 2, wallet))).toBe(true);
    const prepare = ixOf('prepare');
    expect(Buffer.from(prepare.discriminator).equals(prepareData())).toBe(true);
    expect(prepare.args).toEqual([]);
    expect(prepare.accounts.map((x) => x.name)).toEqual(['payer', 'mint', 'state', 'registry', 'system_program', 'rule_set']);
    expect(flagsOf(prepare.accounts)).toEqual(prepareKeys(payer, mint, config).map((m) => [m.isSigner, m.isWritable]));
    expect(Buffer.from(ixOf('record_payout').discriminator).toString('hex')).toBe(createHash('sha256').update('global:record_payout').digest().subarray(0, 8).toString('hex'));
  });

  it('numbers and names its errors as the shared tables do, the four refusals explained as the API says them', () => {
    expect(Object.fromEntries(idl.errors.map((e) => [e.code, e.name]))).toEqual(RULES_ENGINE_ERRORS);
    for (const [reason, name] of Object.entries(RULES_REFUSAL_ERRORS) as [keyof typeof RULES_REFUSAL_TEXT, string][]) {
      const code = idl.errors.find((e) => e.name === name)!.code;
      expect(explainProgramError('rulesHook', code)).toMatchObject({ program: 'rulesHook', name, explanation: RULES_REFUSAL_TEXT[reason] });
      expect(explainProgramError(RULES_ENGINE_PROGRAM, code).name).toBe(name);
    }
    expect(explainProgramError('rulesHook', 6028).name).toBe('ConfigCreator');
  });

  it('encodes the RuleSet and the state at the layouts’ sizes and offsets', async () => {
    const [config, author, wallet] = [k(), k(), k()];
    const bytes = encodeRules(EXAMPLES['whale-tax']!());
    const rules296 = [...bytes, ...Array<number>(296 - bytes.length).fill(0)];
    const b: Buffer = await CODERS.rulesHook.accounts.encode('ruleSet', { version: 1, bump: 254, config, author, boundAt: new BN(1_700_000_000), destination: 2, destinationWallet: wallet, flags: 65, hash: Array<number>(32).fill(7), len: bytes.length, rules: rules296 });
    expect(b.length).toBe(RULE_SET_LAYOUT.size);
    const r = decodeRuleSetAccount(b);
    expect(r).toMatchObject({ version: 1, bump: 254, boundAt: 1_700_000_000, destination: 'creator', flags: 65 });
    expect([r.config.equals(config), r.author.equals(author), r.destinationWallet!.equals(wallet)]).toEqual([true, true, true]);
    expect(rulesToHex(r.bytes)).toBe(rulesToHex(bytes));
    const keys = Array.from({ length: 8 }, () => k());
    const s: Buffer = await CODERS.rulesHook.accounts.encode('rulesState', { version: 1, bump: 250, mint: keys[0], launch: keys[1], pool: keys[2], config: keys[3], ruleSet: keys[4], destinationHolding: keys[5], destinationOwner: keys[6], preparedBy: keys[7], preparedAt: new BN(1_700_000_000), reference: new BN(0), referenceAt: new BN(0), paidTotal: new BN(5_000), records: new BN(3), flags: 65, rulesLen: bytes.length, rules: rules296, creatorBump: 251, reserved: Array<number>(21).fill(0) });
    expect(s.length).toBe(RULES_STATE_LAYOUT.size);
    const d = decodeRulesState(s);
    expect(d).toMatchObject({ version: 1, bump: 250, preparedAt: 1_700_000_000, paidTotal: 5_000n, records: 3n, flags: 65, creatorBump: 251 });
    expect([d.mint, d.launch, d.pool, d.config, d.ruleSet, d.destinationHolding, d.destinationOwner, d.preparedBy].map((x, i) => x.equals(keys[i]!))).toEqual(Array(8).fill(true));
  });

  it('reads Bound and Prepared from the engine’s logs (emit!, not a self-CPI), and nothing another program logged', () => {
    const engine = RULES_ENGINE_PROGRAM.toBase58();
    const [config, ruleSet, author] = [k(), k(), k()];
    const disc = idl.events.find((e) => e.name === 'Bound')!.discriminator;
    const body = CODERS.rulesHook.types.encode('bound', { config, ruleSet, author, destination: 1, destinationWallet: PublicKey.default, flags: 209, hash: Array<number>(32).fill(1), len: 56 });
    const line = `Program data: ${Buffer.concat([Buffer.from(disc), body]).toString('base64')}`;
    const other = k().toBase58();
    const logs = [
      `Program ${LAUNCH_PROGRAM.toBase58()} invoke [1]`,
      line,
      `Program ${LAUNCH_PROGRAM.toBase58()} success`,
      `Program ${engine} invoke [1]`,
      'Program log: Instruction: Bind',
      `Program ${other} invoke [2]`,
      line,
      `Program ${other} success`,
      line,
      `Program ${engine} consumed 24000 of 200000 compute units`,
      `Program ${engine} success`,
    ];
    const events = logEventsOf(logs, ['rulesHook'], 3);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ ordinal: 3, program: 'rulesHook', programId: engine });
    expect(events[0]!.name.toLowerCase()).toBe('bound');
    expect(events[0]!.data).toMatchObject({ config: config.toBase58(), ruleSet: ruleSet.toBase58(), author: author.toBase58(), destination: 1, flags: 209, len: 56 });
    expect(logEventsOf(logs.filter((l) => !l.startsWith(`Program ${engine}`)))).toEqual([]);
  });

  it('lists the four extras prepare registers: the destination holding writable, the default key read-only without one', () => {
    const [mint, preparer, wallet] = [k(), k(), k()];
    const pool = launchPoolAddress(mint, BRIDGED_SOL_MINT, 30);
    const burn = rulesHookExtras({ destination: 'burn' }, mint, preparer);
    expect(burn.map((m) => [m.pubkey.toBase58(), m.isWritable])).toEqual([
      [rulesStateAddress(mint).toBase58(), false],
      [launchAddress(mint).toBase58(), false],
      [pool.toBase58(), false],
      [holdingAddress(mint, launchAddress(mint)).toBase58(), true],
    ]);
    expect(rulesHookExtras({ destination: 'creator' }, mint, preparer)[3]!.pubkey.equals(holdingAddress(mint, preparer))).toBe(true);
    expect(rulesHookExtras({ destination: 'named' }, mint, preparer, wallet)[3]!.pubkey.equals(holdingAddress(mint, wallet))).toBe(true);
    const none = rulesHookExtras({ destination: 'none' }, mint, preparer);
    expect(none.length).toBe(4);
    expect(none[3]).toMatchObject({ isWritable: false, isSigner: false });
    expect(none[3]!.pubkey.equals(PublicKey.default)).toBe(true);
  });
});
