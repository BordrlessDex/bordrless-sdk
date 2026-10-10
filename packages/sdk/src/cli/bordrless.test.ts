/** The open deploy CLI (phase 3a §6.3): its arguments, its delays, and the plans it runs. */
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { timelockAddress, trimmedLength } from '../authority.ts';
import { CODERS } from '../coders.ts';
import { timelock } from '../timelock.ts';
import { budgetIxs, deployPlan, parseArgs, parseDelay, priorityFeeOf, proposePlan, proposeUnits, sbpfVersion, simulatedLimit, solanaConfig, stepUnits, MAX_COMPUTE_UNITS, STEP_UNITS, type Step } from './bordrless.ts';

describe('the bordrless CLI', () => {
  it('parses a kind, a command, positionals and flags', () => {
    expect(parseArgs(['hook', 'deploy', 'h.so', '--timelock', '7d', '--print'])).toEqual({ kind: 'hook', command: 'deploy', positional: ['h.so'], flags: { timelock: '7d', print: true } });
    expect(() => parseArgs(['token', 'deploy'])).toThrow(/usage/);
    expect(() => parseArgs(['strategy'])).toThrow(/usage/);
  });

  it('takes delays of 3 to 365 days', () => {
    expect(parseDelay('3d')).toBe(259_200);
    expect(parseDelay('72h')).toBe(259_200);
    expect(parseDelay('259200')).toBe(259_200);
    expect(() => parseDelay('2d')).toThrow(/at least 3 days/);
    expect(() => parseDelay('366d')).toThrow(/at most 365/);
    expect(() => parseDelay('soon')).toThrow(/not a delay/);
  });

  it('deploys immutable or timelocked, never leaving the author an upgrade key', () => {
    const payer = Keypair.generate().publicKey;
    const program = Keypair.generate().publicKey;
    const immutable = deployPlan('h.so', 'kp.json', payer, { immutable: true }, program, null);
    expect(immutable.map((s) => (s.kind === 'shell' ? s.args.slice(0, 2).join(' ') : 'tx'))).toEqual(['program deploy', 'program set-upgrade-authority', 'export-pda-tx --program-id']);
    expect(immutable[1]!.kind === 'shell' && immutable[1]!.args.includes('--final')).toBe(true);
    const author = Keypair.generate().publicKey;
    const locked = deployPlan('h.so', 'kp.json', payer, { delaySecs: 7 * 86_400, author }, program, 'http://localhost:8899', '/me.json');
    // Round 1 (F-C1): every shell step gets the cluster and the keypair the CLI's own transactions use.
    const deploy = locked[0]!;
    expect(deploy.kind === 'shell' && deploy.args.join(' ')).toContain('--upgrade-authority /me.json --url http://localhost:8899 --keypair /me.json');
    const reg = locked[1]!;
    expect(reg.kind).toBe('tx');
    if (reg.kind === 'tx') {
      expect(reg.ixs[0]!.data).toEqual(timelock.register(payer, payer, program, 7 * 86_400, author).data);
      const decoded = CODERS.hookTimelock.instruction.decode(reg.ixs[0]!.data) as { name: string; data: { delaySecs: number; author: PublicKey } };
      expect([decoded.name, decoded.data.delaySecs, decoded.data.author.toBase58()]).toEqual(['register', 604_800, author.toBase58()]);
    }
  });

  it('reads the Solana CLI’s cluster and keypair, and knows SBPF v3 code', () => {
    expect(solanaConfig(() => 'Config File: /c.yml\nRPC URL: https://api.devnet.solana.com \nWebSocket URL: x\nKeypair Path: /k/id.json \nCommitment: confirmed\n')).toEqual({ url: 'https://api.devnet.solana.com', keypair: '/k/id.json' });
    expect(solanaConfig(() => {
      throw new Error('no solana');
    })).toEqual({ url: null, keypair: null });
    const elf = Buffer.alloc(64);
    elf.writeUInt32BE(0x7f454c46, 0);
    elf[4] = 2;
    elf.writeUInt32LE(3, 48);
    expect(sbpfVersion(elf)).toBe(3);
    elf.writeUInt32LE(0, 48);
    expect(sbpfVersion(elf)).toBe(0);
    expect(sbpfVersion(Buffer.from('not an elf'))).toBe(null);
  });

  it('refuses a buffer holding other code than the file (round 1, F-C2)', () => {
    const author = Keypair.generate().publicKey;
    const program = Keypair.generate().publicKey;
    const code = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9]), Buffer.alloc(100)]);
    const buffer = Keypair.generate().publicKey;
    expect(() => proposePlan('h.so', code, author, program, buffer, null, null, Buffer.from([1, 2, 3]))).toThrow(/holds code/);
    expect(proposePlan('h.so', code, author, program, buffer, null, null, Buffer.concat([code, Buffer.alloc(50)])).length).toBe(2);
  });

  it('proposes a buffer handed to the timelock, with the code’s length without trailing zeros', () => {
    const author = Keypair.generate().publicKey;
    const program = Keypair.generate().publicKey;
    const code = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9]), Buffer.alloc(100)]);
    expect(proposePlan('h.so', code, author, program, null, null).map((s) => s.kind)).toEqual(['shell']);
    const buffer = Keypair.generate().publicKey;
    const steps = proposePlan('h.so', code, author, program, buffer, null);
    expect(steps.map((s) => s.kind)).toEqual(['tx', 'tx']);
    const [hand, propose] = steps;
    if (hand?.kind === 'tx' && propose?.kind === 'tx') {
      expect(hand.ixs[0]!.keys.map((k) => k.pubkey.toBase58())).toEqual([buffer, author, timelockAddress(program)].map(String));
      expect(propose.ixs[0]!.data).toEqual(timelock.propose(author, program, buffer, trimmedLength(code)).data);
      expect(trimmedLength(code)).toBe(5);
    }
  });

  describe('compute budgets (audit 3a, integration finding 6)', () => {
    const budgetKind = (ix: TransactionInstruction): string => ComputeBudgetProgram.programId.equals(ix.programId) ? (ix.data[0] === 2 ? 'limit' : ix.data[0] === 3 ? 'price' : 'other') : 'ix';
    const limitOf = (ix: TransactionInstruction): number => ix.data.readUInt32LE(1);

    it('gives propose half a unit a byte plus 15k, with 15% margin, within 1.4M', () => {
      // Measured in LiteSVM (Agave 4.3): 207 KB 117k, 2 MiB 1.057M; the default 200k fails above ~380 KB.
      expect(proposeUnits(207_000)).toBeGreaterThan(117_000);
      expect(proposeUnits(450_000)).toBeGreaterThan(200_000);
      expect(proposeUnits(450_000)).toBe(Math.ceil((15_000 + 225_000) * 1.15));
      const twoMiB = proposeUnits(2 * 1024 * 1024);
      expect(twoMiB).toBeGreaterThan(1_057_000 * 1.1);
      expect(twoMiB).toBeLessThanOrEqual(MAX_COMPUTE_UNITS);
      expect(proposeUnits(10 * 1024 * 1024)).toBe(MAX_COMPUTE_UNITS);
    });

    it('sets a simulated step to 1.15 × what it used plus 5,000, else its fallback', async () => {
      expect(simulatedLimit(100_000)).toBe(120_000);
      expect(simulatedLimit(1_300_000)).toBe(MAX_COMPUTE_UNITS);
      expect(await stepUnits({ simulate: true, fallback: 900_000 }, async () => 16_500)).toBe(Math.ceil(16_500 * 1.15) + 5_000);
      expect(await stepUnits({ simulate: true, fallback: 900_000 }, async () => null)).toBe(900_000);
      expect(await stepUnits({ simulate: true, fallback: 900_000 }, async () => {
        throw new Error('rpc down');
      })).toBe(900_000);
      let asked = false;
      expect(await stepUnits({ units: 60_000 }, async () => {
        asked = true;
        return 1;
      })).toBe(60_000);
      expect(asked).toBe(false);
    });

    it('puts a limit, and the price when one is set, in front of every transaction step', () => {
      expect(budgetIxs(136_000, null).map(budgetKind)).toEqual(['limit']);
      expect(limitOf(budgetIxs(136_000, null)[0]!)).toBe(136_000);
      const priced = budgetIxs(5_000_000, 50_000);
      expect(priced.map(budgetKind)).toEqual(['limit', 'price']);
      expect(limitOf(priced[0]!)).toBe(MAX_COMPUTE_UNITS);
      expect(priced[1]!.data.readBigUInt64LE(1)).toBe(50_000n);
      const payer = Keypair.generate().publicKey;
      const program = Keypair.generate().publicKey;
      const code = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9]), Buffer.alloc(450_000, 1)]);
      const steps: Step[] = [
        ...deployPlan('h.so', 'kp.json', payer, { delaySecs: 3 * 86_400, author: payer }, program, null, null, 7),
        ...proposePlan('h.so', code, payer, program, Keypair.generate().publicKey, null, null, null, 7),
      ];
      const txs = steps.filter((s): s is Extract<Step, { kind: 'tx' }> => s.kind === 'tx');
      expect(txs.length).toBe(3);
      for (const s of txs) expect(s.budget).toBeDefined();
      const [register, hand, propose] = txs;
      expect(register!.budget).toEqual({ units: STEP_UNITS.register });
      expect(hand!.budget).toEqual({ units: STEP_UNITS.setAuthority });
      expect(propose!.budget).toEqual({ units: proposeUnits(code.length) });
      expect('units' in propose!.budget && propose!.budget.units).toBeGreaterThan(200_000);
      // The solana commands that send transactions get the price too.
      const deploy = steps[0]!;
      expect(deploy.kind === 'shell' && deploy.args.join(' ')).toContain('--with-compute-unit-price 7');
      const write = proposePlan('h.so', code, payer, program, null, null, null, null, 7)[0]!;
      expect(write.kind === 'shell' && write.args.join(' ')).toContain('write-buffer h.so --with-compute-unit-price 7');
      expect(deployPlan('h.so', 'kp.json', payer, { immutable: true }, program, null)[0]!.kind === 'shell' && (deployPlan('h.so', 'kp.json', payer, { immutable: true }, program, null)[0] as { args: string[] }).args).not.toContain('--with-compute-unit-price');
    });

    it('reads the priority fee from --priority-fee or BORDRLESS_PRIORITY_FEE', () => {
      expect(priorityFeeOf(undefined, undefined)).toBe(null);
      expect(priorityFeeOf('25000', undefined)).toBe(25_000);
      expect(priorityFeeOf(undefined, '1000')).toBe(1_000);
      expect(priorityFeeOf('5', '1000')).toBe(5);
      expect(priorityFeeOf('0', undefined)).toBe(null);
      expect(() => priorityFeeOf('fast', undefined)).toThrow(/not a priority fee/);
      expect(() => priorityFeeOf(true, undefined)).toThrow(/micro-lamports/);
    });
  });
});
