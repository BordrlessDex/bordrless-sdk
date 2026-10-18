/**
 * `agent.json` (docs/agents.md): what a companion script's agent may decide: its options, sizes,
 * gates, the facts it sees, its confidence and cadence; beside `src/` as `keeper.json` sits. The
 * schema, its bounds, its words and the decision's bytes are @bordrless/shared's (`agent.ts`),
 * re-exported here; `checkAgentJson` is the Workshop's own check, to run before submitting.
 *
 * `decideInstruction` builds the script's `decide` (docs/agents.md "The decision on chain"): the
 * keeper, signing with Bordrless's agent key (`AGENT_KEY`), writes a decision into the last 64 bytes
 * of the script's state (`scriptStateAddress(mint)`, the companion's PDA the script owns) before the
 * step. Its arguments are Borsh in the starter's order (`DecideArgs`); the program fills `decided_at`
 * from the clock and refuses a `seq` at or under the one stored.
 */
import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { AGENT_KEY, agentDetails, agentWords, encodeAgentDecision, parseAgentDeclaration, type AgentDecision, type AgentDeclaration } from '@bordrless/shared';
import { scriptStateAddress } from './addresses.ts';

export {
  AGENT_CADENCE_ON,
  AGENT_DECISION_LEN,
  AGENT_DECISION_MAGIC,
  AGENT_DECISION_VERSION,
  AGENT_FILE,
  AGENT_KEY,
  AGENT_LIMITS,
  AGENT_STATE_FIELDS,
  AGENT_STATE_WORDS,
  AGENT_VERSION,
  agentDeclarationOf,
  agentDecisionSeqOf,
  agentDetails,
  agentOfFiles,
  agentWords,
  canonicalAgentJson,
  decodeAgentDecision,
  encodeAgentDecision,
  isAgentFile,
  parseAgentDeclaration,
  type AgentCadence,
  type AgentCadenceOn,
  type AgentDecision,
  type AgentDeclaration,
  type AgentGate,
  type AgentOption,
  type AgentParse,
  type AgentStateField,
} from '@bordrless/shared';

/** What `checkAgentJson` says of a file: its normal form and the words the Workshop's page will show, or the one sentence the Workshop would refuse it with. */
export type AgentCheck = { ok: true; declaration: AgentDeclaration; words: string; details: string[] } | { ok: false; problem: string };

/** Checks an `agent.json`'s text as the Workshop does when it is submitted (size, JSON, the schema and its bounds). */
export function checkAgentJson(text: string): AgentCheck {
  const parsed = parseAgentDeclaration(text);
  if (!parsed.ok) return parsed;
  return { ok: true, declaration: parsed.declaration, words: agentWords(parsed.declaration), details: agentDetails(parsed.declaration) };
}

/** A declaration as an `agent.json` to save beside `src/`: two-space JSON and a newline. */
export const agentJson = (d: AgentDeclaration): string => `${JSON.stringify(d, null, 2)}\n`;

/** The example of docs/agents.md: three options, four sizes, one gate, every fact, a decision after every trade at most once a minute. */
export const AGENT_EXAMPLE: AgentDeclaration = {
  version: 1,
  instruction: 'Grow the holder base and defend the price. Buy and burn on dips of 3% or more; pay patient holders when the pot is large and the market is calm; hold while the price climbs. Never spend more than a tenth of the pot in a day.',
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

// ---- `decide` ---------------------------------------------------------------------------------------

/** Bordrless's agent key as a public key: the one signer `decide` takes. */
export const AGENT_SIGNER = new PublicKey(AGENT_KEY);

/** `sha256("global:decide")[..8]`: Anchor's discriminator for the starter's `decide`. */
export const DECIDE_DISCRIMINATOR: Buffer = createHash('sha256').update('global:decide').digest().subarray(0, 8);

/** `decide`'s arguments, Borsh in this order (the starter's `DecideArgs`). */
export interface DecideArgs {
  /** The option's `code`. */
  action: number;
  /** The `sizes` level (0 when none). */
  size: number;
  /** Unix seconds; the decision is void after. */
  until: number;
  /** One over the `seq` the state holds: the program refuses a replay. */
  seq: number;
  /** The model's confidence, basis points. */
  confidenceBps: number;
  /** SHA-256 of the state the model saw, 32 bytes. */
  stateHash: Uint8Array;
  /** What the step pays the treasury for the inference, lamports (docs/agents.md "Billing"; 0 when nothing is owed). */
  billLamports: number;
}

/** The arguments' Borsh size: u8, u8, i64, u32, u16, [u8; 32], u32. */
export const DECIDE_ARGS_LEN = 52;

const u8 = (name: string, v: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`${name} is a byte`);
  return v;
};
const u16 = (name: string, v: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`${name} is a u16`);
  return v;
};
const u32 = (name: string, v: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error(`${name} is a u32`);
  return v;
};

/** The arguments as Borsh, in the starter's order: 52 bytes. */
export function encodeDecideArgs(args: DecideArgs): Buffer {
  if (args.stateHash.length !== 32) throw new Error('stateHash is 32 bytes');
  if (!Number.isSafeInteger(args.until)) throw new Error('until is unix seconds');
  const out = Buffer.alloc(DECIDE_ARGS_LEN);
  out.writeUInt8(u8('action', args.action), 0);
  out.writeUInt8(u8('size', args.size), 1);
  out.writeBigInt64LE(BigInt(args.until), 2);
  out.writeUInt32LE(u32('seq', args.seq), 10);
  out.writeUInt16LE(u16('confidenceBps', args.confidenceBps), 14);
  out.set(args.stateHash, 16);
  out.writeUInt32LE(u32('billLamports', args.billLamports), 48);
  return out;
}

/** The tail `decide` leaves in the state for these arguments (the program fills `decided_at` from the clock): what `read_decision` then reads. */
export const decisionOfArgs = (args: DecideArgs, decidedAt: number): AgentDecision => ({ action: args.action, size: args.size, billLamports: args.billLamports, until: args.until, decidedAt, seq: args.seq, confidenceBps: args.confidenceBps, stateHash: args.stateHash });

/** The 64 bytes `decide` writes for these arguments (`decisionOfArgs`, encoded). */
export const decisionBytesOfArgs = (args: DecideArgs, decidedAt: number): Uint8Array => encodeAgentDecision(decisionOfArgs(args, decidedAt));

/**
 * The script program's `decide`: `[agent (signer; must be AGENT_KEY), mint, state (writable;
 * `scriptStateAddress(mint)`, which the program holds to the companion's seeds and its own
 * ownership)]`, the discriminator then the arguments. The agent key signs; whoever pays the
 * transaction (the keeper's crank key) signs it too, as a plain fee payer.
 */
export function decideInstruction(input: { program: PublicKey; mint: PublicKey; agent?: PublicKey; args: DecideArgs }): TransactionInstruction {
  return new TransactionInstruction({
    programId: input.program,
    keys: [
      { pubkey: input.agent ?? AGENT_SIGNER, isSigner: true, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: scriptStateAddress(input.mint), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([DECIDE_DISCRIMINATOR, encodeDecideArgs(input.args)]),
  });
}
