/**
 * `agent.json` (docs/agents.md): what a companion script's agent may decide, in data beside the
 * code. An agent coin's script lets a model choose, every trade or every step, which of the
 * script's options to take and at what size, within caps compiled into the script; the model runs
 * off chain, Bordrless's keeper signs its choice into the script's state (its last 64 bytes, the
 * decision below) before the step, and the step does that and nothing else. The file sits at the
 * root of the script's source beside `src/` (a pair's script half), as `keeper.json` does, goes
 * into the Workshop with the source (read by the reading, part of the source's hash, bound by the
 * approval), and is refused beside a hook.
 *
 * `parseAgentDeclaration` holds a file to the schema and its bounds and answers the normal form or
 * one sentence saying what is wrong; `agentWords` says it in plain words for a card; the decision's
 * layout is encoded and decoded here too, so the keeper, the SDK and the site read one shape. No
 * Solana dependencies.
 */
import { utf8Length } from './keeper.ts';

/** The file, at the root of a companion script's submitted source (beside `src/`). */
export const AGENT_FILE = 'agent.json';
/** The schema's version: the only one there is. */
export const AGENT_VERSION = 1;

/** The bounds a declaration is held to. */
export const AGENT_LIMITS = {
  /** The file's bytes (UTF-8). */
  bytes: 4_096,
  /** The instruction's characters. */
  instructionMin: 20,
  instruction: 1_000,
  /** Options: how many, a name's characters, an `about`'s characters, the largest code. */
  options: 16,
  optionName: 24,
  optionAbout: 200,
  maxCode: 15,
  /** Sizes: how many levels (TypeSafe's Score takes 2 to 10), a level's characters. */
  sizesMin: 2,
  sizes: 10,
  sizeWords: 60,
  /** Gates: how many, a name's and a question's characters. */
  gates: 4,
  gateAsk: 200,
  /** The least confidence that may be asked for. */
  confidenceMin: 0.5,
  /** The cadence's least and most seconds (the companion's step bounds). */
  minSecs: 10,
  maxSecs: 86_400,
  /** Self-evolving (docs/agents.md phase 3): the least and most seconds between the brain's reviews of its options, and the default. */
  evolveMinSecs: 86_400,
  evolveMaxSecs: 30 * 86_400,
  evolveDefaultSecs: 86_400,
} as const;

/** The facts the keeper can put in a state, by name (docs/agents.md "The brain"). */
export const AGENT_STATE_FIELDS = ['price', 'dip', 'depth', 'volume', 'flow', 'holders', 'pot', 'last'] as const;
export type AgentStateField = (typeof AGENT_STATE_FIELDS)[number];
/** Each fact in plain words. */
export const AGENT_STATE_WORDS: Record<AgentStateField, string> = {
  price: 'the price now and its change over an hour and a day',
  dip: 'how far the price is under its highs of the hour and the day',
  depth: 'the SOL in the coin’s pool',
  volume: 'the SOL traded in an hour and a day',
  flow: 'net buying or selling over an hour and a day',
  holders: 'how many hold the coin and the day’s change',
  pot: 'the SOL in the pot',
  last: 'the last action, how long ago, and what today’s actions spent',
};

export type AgentCadenceOn = 'trade' | 'step';
export const AGENT_CADENCE_ON: readonly AgentCadenceOn[] = ['trade', 'step'];

/** One of the script's actions: the code the step reads, a name, and what the step does with it (what the model chooses by). */
export interface AgentOption {
  code: number;
  name: string;
  about: string;
}

/** A yes/no question whose answer stops an action when its probability is over `max`. */
export interface AgentGate {
  name: string;
  ask: string;
  max: number;
}

export interface AgentCadence {
  on: AgentCadenceOn;
  minSecs: number;
}

/**
 * Self-evolving (docs/agents.md phase 3; the owner, 18 Oct 2026: no timelock, no cancel): the brain
 * reviews the agent's options against its log every `every` seconds (a day by default, a day to 30
 * days) and, when they fall short of the standing orders, rewrites the script with a new option; a
 * rewrite that passes the Workshop's checks and the reading goes live by itself.
 */
export interface AgentEvolve {
  every: number;
}

/** A declaration in its normal form: what `parseAgentDeclaration` answers, what the Workshop stores and hashes, what the keeper runs. */
export interface AgentDeclaration {
  version: 1;
  instruction: string;
  /** In order of code; the first is code 0, `hold`. */
  options: AgentOption[];
  /** Absent when every action has its one size. */
  sizes?: string[];
  /** Absent when none. */
  gates?: AgentGate[];
  state: AgentStateField[];
  confidence: number;
  cadence: AgentCadence;
  /** Absent when the agent never rewrites itself (the default). */
  evolve?: AgentEvolve;
}

export type AgentParse = { ok: true; declaration: AgentDeclaration } | { ok: false; problem: string };

class AgentProblem extends Error {}

/** Refuses with one sentence, the file named first. */
const fail = (sentence: string): never => {
  throw new AgentProblem(`${AGENT_FILE}: ${sentence}`);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const group = (n: number): string => n.toLocaleString('en-US');

/** An object with only the fields allowed, named so an unknown one is said. */
function fieldsOf(v: unknown, at: string, allowed: readonly string[], shape: string): Record<string, unknown> {
  if (!isObject(v)) return fail(`${at} is an object: ${shape}.`);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${at} has no field "${k}" (its fields: ${allowed.join(', ')}).`);
  return v;
}

const NAME = /^[a-z][a-z0-9_]*$/;

function optionsOf(v: unknown): AgentOption[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > AGENT_LIMITS.options) return fail(`options is a list of 2 to ${AGENT_LIMITS.options} actions, the first { "code": 0, "name": "hold", ... }.`);
  const codes = new Set<number>();
  const names = new Set<string>();
  const options = v.map((item, i) => {
    const at = `options[${i}]`;
    const o = fieldsOf(item, at, ['code', 'name', 'about'], '{ "code", "name", "about" }');
    if (typeof o.code !== 'number' || !Number.isInteger(o.code) || o.code < 0 || o.code > AGENT_LIMITS.maxCode) fail(`${at}.code is the number the step reads: a whole number from 0 to ${AGENT_LIMITS.maxCode}.`);
    if (typeof o.name !== 'string' || !NAME.test(o.name) || o.name.length > AGENT_LIMITS.optionName) fail(`${at}.name is a word of lower-case letters, digits and underscores, at most ${AGENT_LIMITS.optionName} characters.`);
    if (typeof o.about !== 'string' || o.about.trim().length === 0 || o.about.length > AGENT_LIMITS.optionAbout) fail(`${at}.about says what the step does with it, 1 to ${AGENT_LIMITS.optionAbout} characters.`);
    if (codes.has(o.code as number)) fail(`${at}.code ${o.code} is used twice.`);
    if (names.has(o.name as string)) fail(`${at}.name "${o.name}" is used twice.`);
    codes.add(o.code as number);
    names.add(o.name as string);
    return { code: o.code as number, name: o.name as string, about: (o.about as string).trim() };
  });
  if (options[0]!.code !== 0 || options[0]!.name !== 'hold') fail('options[0] is { "code": 0, "name": "hold", ... }: what the step does with no decision.');
  for (let i = 1; i < options.length; i++) if (options[i]!.code <= options[i - 1]!.code) fail('options are in order of code.');
  return options;
}

function sizesOf(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < AGENT_LIMITS.sizesMin || v.length > AGENT_LIMITS.sizes || !v.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= AGENT_LIMITS.sizeWords)) {
    return fail(`sizes is a list of ${AGENT_LIMITS.sizesMin} to ${AGENT_LIMITS.sizes} levels in words, smallest first, each 1 to ${AGENT_LIMITS.sizeWords} characters.`);
  }
  return v.map((s: string) => s.trim());
}

function gatesOf(v: unknown): AgentGate[] {
  if (!Array.isArray(v) || v.length > AGENT_LIMITS.gates) return fail(`gates is a list of at most ${AGENT_LIMITS.gates} yes/no questions, each { "name", "ask", "max" }.`);
  const names = new Set<string>();
  return v.map((item, i) => {
    const at = `gates[${i}]`;
    const g = fieldsOf(item, at, ['name', 'ask', 'max'], '{ "name", "ask", "max" }');
    if (typeof g.name !== 'string' || !NAME.test(g.name) || g.name.length > AGENT_LIMITS.optionName) fail(`${at}.name is a word of lower-case letters, digits and underscores, at most ${AGENT_LIMITS.optionName} characters.`);
    if (typeof g.ask !== 'string' || g.ask.trim().length === 0 || g.ask.length > AGENT_LIMITS.gateAsk) fail(`${at}.ask is the yes/no question, 1 to ${AGENT_LIMITS.gateAsk} characters.`);
    if (typeof g.max !== 'number' || !(g.max >= 0 && g.max <= 1)) fail(`${at}.max is the largest probability of yes under which the agent may act: 0 to 1.`);
    if (names.has(g.name as string)) fail(`${at}.name "${g.name}" is used twice.`);
    names.add(g.name as string);
    return { name: g.name as string, ask: (g.ask as string).trim(), max: g.max as number };
  });
}

function stateOf(v: unknown): AgentStateField[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string' && (AGENT_STATE_FIELDS as readonly string[]).includes(s))) {
    return fail(`state is a list of at least one of the facts the model sees: ${AGENT_STATE_FIELDS.join(', ')}.`);
  }
  const seen = new Set<string>();
  for (const s of v as string[]) {
    if (seen.has(s)) fail(`state names "${s}" twice.`);
    seen.add(s);
  }
  return v as AgentStateField[];
}

function cadenceOf(v: unknown): AgentCadence {
  const c = fieldsOf(v, 'cadence', ['on', 'minSecs'], '{ "on": "trade" | "step", "minSecs" }');
  if (typeof c.on !== 'string' || !AGENT_CADENCE_ON.includes(c.on as AgentCadenceOn)) fail('cadence.on is "trade" (a decision after every trade, at most one per minSecs) or "step" (one per step).');
  if (typeof c.minSecs !== 'number' || !Number.isInteger(c.minSecs) || c.minSecs < AGENT_LIMITS.minSecs || c.minSecs > AGENT_LIMITS.maxSecs) fail(`cadence.minSecs is the least seconds between decisions: a whole number from ${AGENT_LIMITS.minSecs} to ${group(AGENT_LIMITS.maxSecs)}.`);
  return { on: c.on as AgentCadenceOn, minSecs: c.minSecs as number };
}

function evolveOf(v: unknown): AgentEvolve {
  const e = fieldsOf(v, 'evolve', ['every'], '{ "every"?: seconds between reviews }');
  if (e.every === undefined || e.every === null) return { every: AGENT_LIMITS.evolveDefaultSecs };
  if (typeof e.every !== 'number' || !Number.isInteger(e.every) || e.every < AGENT_LIMITS.evolveMinSecs || e.every > AGENT_LIMITS.evolveMaxSecs) {
    fail(`evolve.every is the seconds between the brain’s reviews of its options: a whole number from ${group(AGENT_LIMITS.evolveMinSecs)} (a day) to ${group(AGENT_LIMITS.evolveMaxSecs)} (30 days).`);
  }
  return { every: e.every as number };
}

/** The declaration in a parsed JSON value, held to the schema and its bounds: its normal form, or why not, in one sentence. */
export function agentDeclarationOf(value: unknown): AgentParse {
  try {
    const root = fieldsOf(value, 'the file', ['version', 'instruction', 'options', 'sizes', 'gates', 'state', 'confidence', 'cadence', 'evolve'], '{ "version": 1, "instruction", "options", "sizes"?, "gates"?, "state", "confidence", "cadence", "evolve"? }');
    if (root.version !== AGENT_VERSION) fail(`version is ${AGENT_VERSION}, the only one there is.`);
    const instruction = typeof root.instruction === 'string' ? root.instruction.replace(/\s+/g, ' ').trim() : '';
    if (instruction.length < AGENT_LIMITS.instructionMin || instruction.length > AGENT_LIMITS.instruction) fail(`instruction is the agent’s standing orders in plain words, ${AGENT_LIMITS.instructionMin} to ${group(AGENT_LIMITS.instruction)} characters.`);
    const options = optionsOf(root.options);
    const sizes = root.sizes === undefined || root.sizes === null ? null : sizesOf(root.sizes);
    const gates = root.gates === undefined || root.gates === null ? [] : gatesOf(root.gates);
    const state = stateOf(root.state);
    if (typeof root.confidence !== 'number' || !(root.confidence >= AGENT_LIMITS.confidenceMin && root.confidence <= 1)) fail(`confidence is the least confidence in the chosen option to act on it: ${AGENT_LIMITS.confidenceMin} to 1.`);
    const cadence = cadenceOf(root.cadence);
    const evolve = root.evolve === undefined || root.evolve === null ? null : evolveOf(root.evolve);
    return { ok: true, declaration: { version: 1, instruction, options, ...(sizes ? { sizes } : {}), ...(gates.length > 0 ? { gates } : {}), state, confidence: root.confidence as number, cadence, ...(evolve ? { evolve } : {}) } };
  } catch (error) {
    if (error instanceof AgentProblem) return { ok: false, problem: error.message };
    throw error;
  }
}

/** An `agent.json` as submitted: within its size, JSON, then the schema (`agentDeclarationOf`). */
export function parseAgentDeclaration(text: string): AgentParse {
  const bytes = utf8Length(text);
  if (bytes > AGENT_LIMITS.bytes) return { ok: false, problem: `${AGENT_FILE} is at most ${group(AGENT_LIMITS.bytes)} bytes; this one is ${group(bytes)}.` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: `${AGENT_FILE} is not JSON: check its quotes, commas and brackets (no comments, no trailing commas).` };
  }
  return agentDeclarationOf(value);
}

/** The declaration in a canonical text (keys sorted, no spaces): what its hash is taken of. */
export function canonicalAgentJson(d: AgentDeclaration): string {
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return JSON.stringify(sorted(d));
}

/** Whether a file of a submission is the declaration. */
export const isAgentFile = (path: string): boolean => path === AGENT_FILE;

/** The declaration of a submission's files, in its normal form; null without one (or with a bad one: the submission refused it already). */
export function agentOfFiles(files: readonly { path: string; content: string }[]): AgentDeclaration | null {
  const file = files.find((f) => isAgentFile(f.path));
  if (!file) return null;
  const parsed = parseAgentDeclaration(file.content);
  return parsed.ok ? parsed.declaration : null;
}

// ---- in plain words -------------------------------------------------------------------------------------

const secsWords = (s: number): string => (s % 86_400 === 0 ? `${s / 86_400 === 1 ? 'a day' : `${s / 86_400} days`}` : s % 3_600 === 0 ? `${s / 3_600 === 1 ? 'an hour' : `${s / 3_600} hours`}` : s % 60 === 0 ? `${s / 60 === 1 ? 'a minute' : `${s / 60} minutes`}` : `${s} seconds`);
/** "every day", "every 3 days", "every 12 hours": a period as a card says it. */
const everyWords = (s: number): string => (s % 86_400 === 0 ? `every ${s / 86_400 === 1 ? 'day' : `${s / 86_400} days`}` : s % 3_600 === 0 ? `every ${s / 3_600 === 1 ? 'hour' : `${s / 3_600} hours`}` : `every ${secsWords(s)}`);
const list = (words: string[]): string => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/** The self-evolving clause, as the card's sentence and the details' line say it. */
const evolveWords = (e: AgentEvolve): string => `rewrites itself when its options fall short, reviewed ${everyWords(e.every)}`;

/** One sentence a card shows: what the agent decides among, how often, at what confidence, what holds it, and whether it rewrites itself. */
export function agentWords(d: AgentDeclaration): string {
  const names = d.options.map((o) => o.name.replace(/_/g, ' '));
  const when = d.cadence.on === 'trade' ? `after every trade, at most once ${d.cadence.minSecs === 60 ? 'a minute' : `every ${secsWords(d.cadence.minSecs)}`}` : 'every step';
  const parts = [`Decides ${when} among ${list(names)}${d.sizes ? ` at ${d.sizes.length} sizes` : ''}`, `acts at ${Math.round(d.confidence * 100)}% confidence or more`];
  if (d.gates?.length) parts.push(`holds when ${list(d.gates.map((g) => g.name.replace(/_/g, ' ')))} ${d.gates.length === 1 ? 'is' : 'are'} likely`);
  if (d.evolve) parts.push(evolveWords(d.evolve));
  return `${parts.join('; ')}.`;
}

/** Each fact of the declaration on its own line: the instruction, every option, the sizes, the gates, what it sees, and whether it rewrites itself. */
export function agentDetails(d: AgentDeclaration): string[] {
  const lines = [`Instruction: ${d.instruction}`, ...d.options.map((o) => `${o.name.replace(/_/g, ' ')} (${o.code}): ${o.about}`)];
  if (d.sizes) lines.push(`Sizes: ${d.sizes.map((s, i) => `${i} ${s}`).join('; ')}`);
  for (const g of d.gates ?? []) lines.push(`Holds when "${g.ask}" is over ${Math.round(g.max * 100)}% likely`);
  lines.push(`Sees: ${list(d.state.map((s) => AGENT_STATE_WORDS[s]))}`);
  if (d.evolve) lines.push(`${evolveWords(d.evolve).replace(/^r/, 'R')}; a rewrite that passes the Workshop’s checks and the reading goes live by itself`);
  return lines;
}

// ---- the decision on chain ------------------------------------------------------------------------------

// Bordrless's agent key, the one signer a script's `decide` takes, is `AGENT_KEY` in programs.ts with the protocol's other fixed keys.

/** The decision's bytes at the end of the script's state (docs/agents.md "The decision on chain"). */
export const AGENT_DECISION_LEN = 64;
export const AGENT_DECISION_MAGIC = 0xa6;
export const AGENT_DECISION_VERSION = 1;

export interface AgentDecision {
  action: number;
  size: number;
  /** What the step pays the treasury for the inference, lamports (0 until inference is billed from the pot, phase 2). */
  billLamports: number;
  /** Unix seconds; void after. */
  until: number;
  decidedAt: number;
  seq: number;
  confidenceBps: number;
  /** SHA-256 of the state the model saw, 32 bytes. */
  stateHash: Uint8Array;
}

/** The 64 bytes of a decision, as `decide` writes them and a step reads them. */
export function encodeAgentDecision(d: AgentDecision): Uint8Array {
  if (d.stateHash.length !== 32) throw new Error('stateHash is 32 bytes');
  const out = new Uint8Array(AGENT_DECISION_LEN);
  const view = new DataView(out.buffer);
  out[0] = AGENT_DECISION_MAGIC;
  out[1] = AGENT_DECISION_VERSION;
  out[2] = d.action;
  out[3] = d.size;
  view.setUint32(4, d.billLamports, true);
  view.setBigInt64(8, BigInt(d.until), true);
  view.setBigInt64(16, BigInt(d.decidedAt), true);
  view.setUint32(24, d.seq, true);
  view.setUint16(28, d.confidenceBps, true);
  out.set(d.stateHash, 32);
  return out;
}

/** The decision in a state's last 64 bytes; null when there is none (no magic, another version, or a state too small to hold one). */
export function decodeAgentDecision(state: Uint8Array): AgentDecision | null {
  if (state.length < AGENT_DECISION_LEN) return null;
  const tail = state.subarray(state.length - AGENT_DECISION_LEN);
  if (tail[0] !== AGENT_DECISION_MAGIC || tail[1] !== AGENT_DECISION_VERSION) return null;
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  return {
    action: tail[2]!,
    size: tail[3]!,
    billLamports: view.getUint32(4, true),
    until: Number(view.getBigInt64(8, true)),
    decidedAt: Number(view.getBigInt64(16, true)),
    seq: view.getUint32(24, true),
    confidenceBps: view.getUint16(28, true),
    stateHash: new Uint8Array(tail.subarray(32, 64)),
  };
}

/**
 * The `seq` a state's tail holds, whatever its magic: a step that spent a decision clears the magic
 * and leaves the rest, and `decide` refuses a `seq` at or under the one stored, so the next decision
 * counts from here, not from the last readable decision. 0 for a state too small to hold one.
 */
export function agentDecisionSeqOf(state: Uint8Array): number {
  if (state.length < AGENT_DECISION_LEN) return 0;
  const tail = state.subarray(state.length - AGENT_DECISION_LEN);
  return new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getUint32(24, true);
}
