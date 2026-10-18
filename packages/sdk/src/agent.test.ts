/** The script's `decide` (docs/agents.md "The decision on chain"): its discriminator, its arguments' Borsh, its accounts, and the tail it leaves read back by the shared decoder. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { AGENT_DECISION_LEN, AGENT_KEY, agentDecisionSeqOf, decodeAgentDecision } from '@bordrless/shared';
import { scriptStateAddress } from './addresses.ts';
import { AGENT_SIGNER, DECIDE_ARGS_LEN, DECIDE_DISCRIMINATOR, decideInstruction, decisionBytesOfArgs, decisionOfArgs, encodeDecideArgs, type DecideArgs } from './agent.ts';

const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
const mint = key(7);
const program = key(9);
const stateHash = Uint8Array.from(createHash('sha256').update('the state the model saw').digest());
const args: DecideArgs = { action: 2, size: 3, until: 1_760_745_600, seq: 42, confidenceBps: 9_150, stateHash, billLamports: 0 };

describe('decide', () => {
  it('is named as Anchor names it', () => {
    expect(DECIDE_DISCRIMINATOR.toString('hex')).toBe('7b7db87df92b710f');
    expect(DECIDE_DISCRIMINATOR.toString('hex')).toBe(createHash('sha256').update('global:decide').digest().subarray(0, 8).toString('hex'));
  });

  it('signs with the agent key', () => {
    expect(AGENT_SIGNER.toBase58()).toBe(AGENT_KEY);
    expect(AGENT_KEY).toBe('6rY39aKYu5B17SAbKNzteJdvpGyJPR5WJ2aaUqrTuJ4Q');
  });

  it('encodes its arguments as Borsh in the starter’s order: 52 bytes', () => {
    const bytes = encodeDecideArgs(args);
    expect(bytes.length).toBe(DECIDE_ARGS_LEN);
    expect([bytes[0], bytes[1]]).toEqual([2, 3]);
    expect(bytes.readBigInt64LE(2)).toBe(1_760_745_600n);
    expect(bytes.readUInt32LE(10)).toBe(42);
    expect(bytes.readUInt16LE(14)).toBe(9_150);
    expect(Buffer.from(bytes.subarray(16, 48)).equals(Buffer.from(stateHash))).toBe(true);
    expect(bytes.readUInt32LE(48)).toBe(0);
    expect(encodeDecideArgs({ ...args, billLamports: 1_500 }).readUInt32LE(48)).toBe(1_500);
    // A negative `until` is an i64 too (the program compares it to the clock; the keeper never sets one).
    expect(encodeDecideArgs({ ...args, until: -1 }).readBigInt64LE(2)).toBe(-1n);
    expect(() => encodeDecideArgs({ ...args, stateHash: new Uint8Array(3) })).toThrow('stateHash is 32 bytes');
    expect(() => encodeDecideArgs({ ...args, action: 256 })).toThrow('action is a byte');
    expect(() => encodeDecideArgs({ ...args, confidenceBps: 70_000 })).toThrow('confidenceBps is a u16');
    expect(() => encodeDecideArgs({ ...args, seq: -1 })).toThrow('seq is a u32');
  });

  it('builds the instruction: the agent signing, the mint, the script’s state writable; the discriminator then the arguments', () => {
    const ix = decideInstruction({ program, mint, args });
    expect(ix.programId.equals(program)).toBe(true);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [AGENT_KEY, true, false],
      [mint.toBase58(), false, false],
      [scriptStateAddress(mint).toBase58(), false, true],
    ]);
    expect(ix.data.length).toBe(60);
    expect(ix.data.subarray(0, 8).equals(DECIDE_DISCRIMINATOR)).toBe(true);
    expect(ix.data.subarray(8).equals(encodeDecideArgs(args))).toBe(true);
    // Another agent key for a test cluster.
    expect(decideInstruction({ program, mint, agent: key(3), args }).keys[0]!.pubkey.equals(key(3))).toBe(true);
  });

  it('leaves a tail the shared decoder reads back, in a state of any size', () => {
    const decidedAt = 1_760_745_540;
    const state = new Uint8Array(1_024);
    state.set(decisionBytesOfArgs(args, decidedAt), state.length - AGENT_DECISION_LEN);
    expect(decodeAgentDecision(state)).toEqual(decisionOfArgs(args, decidedAt));
    expect(decodeAgentDecision(state)).toEqual({ action: 2, size: 3, billLamports: 0, until: 1_760_745_600, decidedAt, seq: 42, confidenceBps: 9_150, stateHash });
    expect(agentDecisionSeqOf(state)).toBe(42);
  });
});
