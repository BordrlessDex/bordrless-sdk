/** `agent.json` (docs/agents.md): the schema, its bounds, its words, and the decision's bytes. */
import { describe, expect, it } from 'vitest';
import { AGENT_DECISION_LEN, agentDecisionSeqOf, agentDetails, agentOfFiles, agentWords, canonicalAgentJson, decodeAgentDecision, encodeAgentDecision, parseAgentDeclaration } from './agent.ts';
import { AGENT_KEY } from './programs.ts';

const EXAMPLE = {
  version: 1,
  instruction: 'Grow the holder base and defend the price. Buy and burn on dips of 3% or more; pay patient holders when the pot is large and the market is calm; hold while the price climbs.',
  options: [
    { code: 0, name: 'hold', about: 'Do nothing this step.' },
    { code: 1, name: 'buy_burn', about: 'Buy the coin on its pool with part of the pot and burn what was bought.' },
    { code: 2, name: 'pay_holders', about: 'Pay part of the pot to holders who held through the last day.' },
  ],
  sizes: ['nothing', 'a 240th of the pot', 'a 60th of the pot', 'a 12th of the pot'],
  gates: [{ name: 'wash', ask: 'Does the last hour’s trading look like wash trading or a sandwich attack?', max: 0.5 }],
  state: ['price', 'dip', 'depth', 'volume', 'flow', 'holders', 'pot', 'last'],
  confidence: 0.8,
  cadence: { on: 'trade', minSecs: 60 },
};
const text = (v: unknown): string => JSON.stringify(v, null, 2);
const problem = (v: unknown): string => {
  const p = parseAgentDeclaration(text(v));
  return p.ok ? 'ok' : p.problem;
};

describe('agent.json', () => {
  it('reads the example into its normal form, and says it in words', () => {
    const p = parseAgentDeclaration(text(EXAMPLE));
    expect(p).toEqual({ ok: true, declaration: EXAMPLE });
    if (!p.ok) return;
    expect(agentWords(p.declaration)).toBe('Decides after every trade, at most once a minute among hold, buy burn and pay holders at 4 sizes; acts at 80% confidence or more; holds when wash is likely.');
    expect(agentDetails(p.declaration)[0]).toBe(`Instruction: ${EXAMPLE.instruction}`);
    expect(agentDetails(p.declaration).at(-1)).toContain('Sees: the price now');
    expect(agentOfFiles([{ path: 'src/lib.rs', content: '' }, { path: 'agent.json', content: text(EXAMPLE) }])).toEqual(EXAMPLE);
    expect(agentOfFiles([{ path: 'src/lib.rs', content: '' }])).toBeNull();
  });

  it('leaves sizes and gates out of the normal form when absent, and words them so', () => {
    const { sizes: _s, gates: _g, ...bare } = EXAMPLE;
    const p = parseAgentDeclaration(text({ ...bare, cadence: { on: 'step', minSecs: 300 } }));
    expect(p.ok && p.declaration).toEqual({ ...bare, cadence: { on: 'step', minSecs: 300 } });
    expect(p.ok && agentWords(p.declaration)).toBe('Decides every step among hold, buy burn and pay holders; acts at 80% confidence or more.');
  });

  it('refuses a file that is not one, with one sentence naming the field', () => {
    expect(problem({ ...EXAMPLE, version: 2 })).toBe('agent.json: version is 1, the only one there is.');
    expect(problem({ ...EXAMPLE, instruction: 'short' })).toContain('instruction is the agent’s standing orders');
    expect(problem({ ...EXAMPLE, options: [EXAMPLE.options[1], EXAMPLE.options[0]] })).toBe('agent.json: options[0] is { "code": 0, "name": "hold", ... }: what the step does with no decision.');
    expect(problem({ ...EXAMPLE, options: [EXAMPLE.options[0], { code: 1, name: 'Buy-Burn', about: 'x' }] })).toContain('options[1].name is a word');
    expect(problem({ ...EXAMPLE, options: [EXAMPLE.options[0], EXAMPLE.options[1], { ...EXAMPLE.options[2], code: 1 }] })).toBe('agent.json: options[2].code 1 is used twice.');
    expect(problem({ ...EXAMPLE, sizes: ['one'] })).toContain('sizes is a list of 2 to 10 levels');
    expect(problem({ ...EXAMPLE, gates: [{ name: 'wash', ask: 'x', max: 2 }] })).toContain('gates[0].max is the largest probability');
    expect(problem({ ...EXAMPLE, state: ['price', 'moon'] })).toContain('state is a list of at least one of the facts');
    expect(problem({ ...EXAMPLE, confidence: 0.2 })).toContain('confidence is the least confidence');
    expect(problem({ ...EXAMPLE, cadence: { on: 'tick', minSecs: 60 } })).toContain('cadence.on is "trade"');
    expect(problem({ ...EXAMPLE, cadence: { on: 'trade', minSecs: 5 } })).toContain('cadence.minSecs is the least seconds');
    expect(problem({ ...EXAMPLE, extra: 1 })).toBe('agent.json: the file has no field "extra" (its fields: version, instruction, options, sizes, gates, state, confidence, cadence, evolve).');
    expect(parseAgentDeclaration('{')).toEqual({ ok: false, problem: 'agent.json is not JSON: check its quotes, commas and brackets (no comments, no trailing commas).' });
    expect(parseAgentDeclaration(text({ ...EXAMPLE, instruction: 'x'.repeat(5_000) })).ok).toBe(false);
  });

  it('reads evolve (self-evolving, docs/agents.md phase 3): a day by default, a day to 30 days, none when left out', () => {
    const daily = parseAgentDeclaration(text({ ...EXAMPLE, evolve: {} }));
    expect(daily.ok && daily.declaration.evolve).toEqual({ every: 86_400 });
    expect(daily.ok && agentWords(daily.declaration)).toBe('Decides after every trade, at most once a minute among hold, buy burn and pay holders at 4 sizes; acts at 80% confidence or more; holds when wash is likely; rewrites itself when its options fall short, reviewed every day.');
    expect(daily.ok && agentDetails(daily.declaration).at(-1)).toBe('Rewrites itself when its options fall short, reviewed every day; a rewrite that passes the Workshop’s checks and the reading goes live by itself');
    const weekly = parseAgentDeclaration(text({ ...EXAMPLE, evolve: { every: 7 * 86_400 } }));
    expect(weekly.ok && weekly.declaration.evolve).toEqual({ every: 604_800 });
    expect(weekly.ok && agentWords(weekly.declaration)).toContain('reviewed every 7 days.');
    // Left out, or null: the agent never rewrites itself, and its words say nothing of it.
    const none = parseAgentDeclaration(text({ ...EXAMPLE, evolve: null }));
    expect(none.ok && 'evolve' in none.declaration).toBe(false);
    expect(none.ok && agentWords(none.declaration)).not.toContain('rewrites');
    expect(problem({ ...EXAMPLE, evolve: { every: 3_600 } })).toBe('agent.json: evolve.every is the seconds between the brain’s reviews of its options: a whole number from 86,400 (a day) to 2,592,000 (30 days).');
    expect(problem({ ...EXAMPLE, evolve: { every: 31 * 86_400 } })).toContain('evolve.every is the seconds');
    expect(problem({ ...EXAMPLE, evolve: true })).toBe('agent.json: evolve is an object: { "every"?: seconds between reviews }.');
    expect(problem({ ...EXAMPLE, evolve: { cancel: true } })).toBe('agent.json: evolve has no field "cancel" (its fields: every).');
  });

  it('hashes one canonical text however the declaration was written', () => {
    const a = parseAgentDeclaration(text(EXAMPLE));
    const b = parseAgentDeclaration(JSON.stringify({ cadence: EXAMPLE.cadence, confidence: 0.8, state: EXAMPLE.state, gates: EXAMPLE.gates, sizes: EXAMPLE.sizes, options: EXAMPLE.options, instruction: `  ${EXAMPLE.instruction}  `, version: 1 }));
    expect(a.ok && b.ok && canonicalAgentJson(a.declaration) === canonicalAgentJson(b.declaration)).toBe(true);
  });
});

describe('the decision', () => {
  const stateHash = new Uint8Array(32).fill(7);
  const d = { action: 2, size: 3, billLamports: 1_500, until: 1_760_745_600, decidedAt: 1_760_745_540, seq: 42, confidenceBps: 9_150, stateHash };

  it('encodes to the 64 bytes a step reads, and reads back from a state’s tail', () => {
    const bytes = encodeAgentDecision(d);
    expect(bytes.length).toBe(AGENT_DECISION_LEN);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0xa6, 1, 2, 3]);
    // bill_lamports at offset 4, u32 LE: 1,500 = 0x05dc.
    expect([bytes[4], bytes[5], bytes[6], bytes[7]]).toEqual([0xdc, 0x05, 0, 0]);
    // seq at offset 24, u32 LE.
    expect([bytes[24], bytes[25], bytes[26], bytes[27]]).toEqual([42, 0, 0, 0]);
    const state = new Uint8Array(200);
    state.set(bytes, 200 - AGENT_DECISION_LEN);
    expect(decodeAgentDecision(state)).toEqual(d);
    expect(decodeAgentDecision(new Uint8Array(200))).toBeNull();
    expect(decodeAgentDecision(new Uint8Array(10))).toBeNull();
    expect(() => encodeAgentDecision({ ...d, stateHash: new Uint8Array(3) })).toThrow('stateHash is 32 bytes');
  });

  it('keeps its seq readable once a step spent it (the magic cleared), so the next decision counts on', () => {
    const state = new Uint8Array(200);
    state.set(encodeAgentDecision(d), 200 - AGENT_DECISION_LEN);
    expect(agentDecisionSeqOf(state)).toBe(42);
    state[200 - AGENT_DECISION_LEN] = 0;
    expect(decodeAgentDecision(state)).toBeNull();
    expect(agentDecisionSeqOf(state)).toBe(42);
    expect(agentDecisionSeqOf(new Uint8Array(200))).toBe(0);
    expect(agentDecisionSeqOf(new Uint8Array(10))).toBe(0);
  });

  it('names the agent key', () => {
    expect(AGENT_KEY).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });
});
