#!/usr/bin/env node
/**
 * `bordrless`: the open deploy CLI (phase 3a, bordrless-programs docs/phase3a.md §6.3). Build, check,
 * deploy and upgrade a token hook or a strategy outside Studio, the way the launchpad and the
 * companion accept it: immutable, or behind a `hook_timelock` (a public delay of at least 3 days),
 * never author-upgradeable.
 *
 *   bordrless hook build [--dir .] [--lib <name>]              solana-verify build; prints the executable hash
 *   bordrless hook sim [--dir .] --image <builder image>      Studio's simulator, locally (a developer tool: proves nothing to anyone else)
 *   bordrless hook deploy <so> --program-keypair <kp> (--immutable | --timelock <3d…365d> [--author <key>])
 *   bordrless hook register --program <id> --timelock <3d…365d> [--author <key>]   (deploy's second step, on its own)
 *   bordrless hook propose <so> --program <id>                write a buffer, hand it to the timelock, propose it
 *   bordrless hook execute|expire|cancel|finalize --program <id> [--buffer <key>]
 *   bordrless hook lengthen --program <id> --delay <dur>
 *   bordrless hook status --program <id>                      the risk label terminals show
 *   bordrless hook verify --program <id> --source <dir> --commit <sha> [--api <url>]
 *   bordrless strategy …                                      the same, for a strategy program
 *
 * Common: `--keypair <path>` (default the Solana CLI's keypair, else ~/.config/solana/id.json: the
 * payer, the deploy's upgrade authority and, by default, the author), `--url <rpc>` (default the
 * Solana CLI's RPC URL), `--print` (show the plan: commands and instructions, send nothing). Both are
 * passed to every `solana` command the CLI runs, so its shell steps and its own transactions go to
 * one cluster with one key. Keys are read from files and never printed. `--priority-fee
 * <microLamports>` (or `BORDRLESS_PRIORITY_FEE`) prices every transaction the CLI sends (and is passed
 * to `solana program deploy` / `write-buffer` as `--with-compute-unit-price`; `set-upgrade-authority`
 * takes no price).
 *
 * Every transaction carries a compute-unit limit (audit 3a, integration finding 6: without one a
 * transaction gets 200k units, and `propose`, which hashes the buffer on chain at about half a unit a
 * byte, failed for any program over about 380 KB): `propose` gets [`proposeUnits`] of its buffer's
 * length, `execute` and `ExtendProgram` (whose cost follows the program's size) are simulated at
 * 1.4M and sent with [`simulatedLimit`] of what they used, the rest a fixed limit with margin.
 *
 * A program going behind a timelock must be SBPF v3 code: the loader refuses to make older code
 * immutable once `disable_sbpf_v0_v1_v2_deployment` is active, so `finalize` could never run.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from '@solana/web3.js';
import { programDataAddress } from '../addresses.ts';
import { decodeTimelock, executableHash, timelockAddress, trimmedLength, MAX_TIMELOCK_DELAY_SECS, MIN_TIMELOCK_DELAY_SECS } from '../authority.ts';
import { hookRiskLabel } from '../risk.ts';
import { loader, timelock } from '../timelock.ts';

export type Kind = 'hook' | 'strategy';

export interface Args {
  kind: Kind;
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Parses `argv` (without node and the script): `<kind> <command> [positional…] [--flag value | --switch]`. */
export function parseArgs(argv: readonly string[]): Args {
  const [kind, command, ...rest] = argv;
  if (kind !== 'hook' && kind !== 'strategy') throw new Error('usage: bordrless <hook|strategy> <command> …');
  if (!command) throw new Error(`usage: bordrless ${kind} <build|sim|deploy|propose|execute|expire|cancel|finalize|lengthen|status|verify>`);
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else flags[name] = true;
    } else positional.push(a);
  }
  return { kind, command, positional, flags };
}

/** A delay: `3d`, `72h`, `259200` (seconds), within `hook_timelock`'s bounds (3 to 365 days). */
export function parseDelay(text: string): number {
  const m = /^(\d+)([dhs]?)$/.exec(text.trim());
  if (!m) throw new Error(`not a delay: ${text} (use 3d, 72h or seconds)`);
  const n = Number(m[1]);
  const secs = m[2] === 'd' ? n * 86_400 : m[2] === 'h' ? n * 3_600 : n;
  if (secs < MIN_TIMELOCK_DELAY_SECS) throw new Error('a timelock delay is at least 3 days');
  if (secs > MAX_TIMELOCK_DELAY_SECS) throw new Error('a timelock delay is at most 365 days');
  return secs;
}

/** The most compute a transaction may ask for. */
export const MAX_COMPUTE_UNITS = 1_400_000;

/**
 * Compute for `hook_timelock::propose` of a buffer holding `bufferLen` bytes of code: the program
 * hashes the code (sha256, about half a unit a byte) and checks the zero tail, plus about 15k of
 * fixed work, with 15% margin, capped at 1.4M. Measured (LiteSVM, Agave 4.3): 207 KB 117k (limit
 * 136k), 450 KB about 240k (limit 276k), 2 MiB, the program's cap, 1.057M (limit 1.223M).
 * `bordrless-programs/programs/tests/tests/indep_3a_integration.rs` holds the formula to the program.
 */
export function proposeUnits(bufferLen: number): number {
  return Math.min(MAX_COMPUTE_UNITS, Math.ceil((15_000 + Math.ceil(bufferLen / 2)) * 1.15));
}

/** The limit a transaction gets from a simulation that used `units`: 15% more, plus 5,000, capped at 1.4M. */
export function simulatedLimit(units: number): number {
  return Math.min(MAX_COMPUTE_UNITS, Math.ceil(units * 1.15) + 5_000);
}

/**
 * Fixed limits (with margin over what the instructions use: the loader's own instructions about
 * 2.4k, `hook_timelock`'s steps that CPI it once or twice well under 40k).
 */
export const STEP_UNITS = {
  /** The loader's `SetAuthority` (handing a buffer to the timelock). */
  setAuthority: 20_000,
  /** `register` (creates the `Timelock`, CPIs the loader's `SetAuthorityChecked`). */
  register: 80_000,
  /** `cancel`, `expire` (CPI the loader's `Close`), `finalize` (`SetAuthority` to none), `lengthen`. */
  timelock: 60_000,
} as const;

/** How a transaction step's compute limit is set: a fixed number, or simulated (falling back to `fallback`). */
export type Budget = { units: number } | { simulate: true; fallback: number };

/** One step of a plan: a shell command, or instructions to sign and send under a compute limit. */
export type Step = { kind: 'shell'; cmd: string; args: string[]; why: string } | { kind: 'tx'; ixs: TransactionInstruction[]; why: string; budget: Budget };

/** The compute-budget instructions put in front of a step's: its limit, and its price when one is set. */
export function budgetIxs(units: number, priorityMicroLamports: number | null): TransactionInstruction[] {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(MAX_COMPUTE_UNITS, Math.max(1, Math.ceil(units))) })];
  if (priorityMicroLamports && priorityMicroLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
  return ixs;
}

/**
 * The limit of a transaction step: its fixed number, or, for a simulated one, [`simulatedLimit`] of
 * what `simulate` (the step's instructions under a 1.4M limit) says it used, else its fallback.
 */
export async function stepUnits(budget: Budget, simulate: () => Promise<number | null>): Promise<number> {
  if ('units' in budget) return budget.units;
  const used = await simulate().catch(() => null);
  return used != null && used > 0 ? simulatedLimit(used) : budget.fallback;
}

/** `--priority-fee <microLamports>` or `BORDRLESS_PRIORITY_FEE`: a non-negative integer, or null. */
export function priorityFeeOf(flag: string | true | undefined, env: string | undefined = process.env.BORDRLESS_PRIORITY_FEE): number | null {
  const text = typeof flag === 'string' ? flag : flag === true ? '' : (env ?? '');
  if (text.trim() === '') {
    if (flag === true) throw new Error('--priority-fee takes micro-lamports per compute unit');
    return null;
  }
  if (!/^\d+$/.test(text.trim())) throw new Error(`not a priority fee: ${text} (micro-lamports per compute unit)`);
  const n = Number(text.trim());
  return n > 0 ? n : null;
}

/** `--with-compute-unit-price` for the `solana` commands that send transactions, when a fee is set. */
const priceFlags = (priority: number | null): string[] => (priority ? ['--with-compute-unit-price', String(priority)] : []);

const str = (f: string | true | undefined, name: string): string => {
  if (typeof f !== 'string') throw new Error(`--${name} is required`);
  return f;
};

/** The Solana CLI's RPC URL and keypair path (`solana config get`), when the CLI is installed. */
export function solanaConfig(read: () => string = () => execFileSync('solana', ['config', 'get'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })): { url: string | null; keypair: string | null } {
  try {
    const text = read();
    const field = (name: string): string | null => new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(text)?.[1] ?? null;
    return { url: field('RPC URL'), keypair: field('Keypair Path') };
  } catch {
    return { url: null, keypair: null };
  }
}

/** The SBPF version an ELF's `e_flags` names (`null`: not a 64-bit ELF). */
export function sbpfVersion(code: Uint8Array): number | null {
  const b = Buffer.from(code.buffer, code.byteOffset, code.byteLength);
  if (b.length < 52 || b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2) return null;
  return b.readUInt32LE(48);
}

/** The `--url` / `--keypair` flags every `solana` command gets. */
const netFlags = (url: string | null, keypair: string | null): string[] => [...(url ? ['--url', url] : []), ...(keypair ? ['--keypair', keypair] : [])];

/**
 * What `deploy` does: `solana program deploy` (your keypair the upgrade authority), then at once
 * either `--final` (immutable) or `hook_timelock`'s `register` (delay, author). It never leaves a
 * program author-upgradeable: the launchpad and the companion would refuse it. (OtterSec's verify
 * PDA: `solana-verify export-pda-tx`, printed as the last step.) `finishCommand` is what to run if
 * the second step fails.
 */
export function deployPlan(so: string, programKeypair: string, payer: PublicKey, mode: { immutable: true } | { delaySecs: number; author: PublicKey }, program: PublicKey, url: string | null, keypair: string | null = null, priority: number | null = null): Step[] {
  const net = netFlags(url, keypair);
  const authority = keypair ? ['--upgrade-authority', keypair] : [];
  const steps: Step[] = [{ kind: 'shell', cmd: 'solana', args: ['program', 'deploy', so, '--program-id', programKeypair, ...authority, ...priceFlags(priority), ...net], why: 'deploy (your keypair is the upgrade authority for one transaction)' }];
  if ('immutable' in mode) steps.push({ kind: 'shell', cmd: 'solana', args: ['program', 'set-upgrade-authority', program.toBase58(), '--final', ...authority, ...net], why: 'make it immutable' });
  else steps.push({ kind: 'tx', ixs: [timelock.register(payer, payer, program, mode.delaySecs, mode.author)], why: `put it behind hook_timelock (${mode.delaySecs / 86_400} days, author ${mode.author.toBase58()})`, budget: { units: STEP_UNITS.register } });
  steps.push({ kind: 'shell', cmd: 'solana-verify', args: ['export-pda-tx', '--program-id', program.toBase58(), '<repo-url>', '--commit-hash', '<commit>'], why: 'publish the verified-build pointer (OtterSec), optional' });
  return steps;
}

/**
 * What `propose` does: write the code to a buffer, hand the buffer to the timelock, propose it with
 * its length without trailing zeros. With the buffer's code read from the chain (`bufferCode`, after
 * its 37-byte header), the hash printed is the buffer's, and a buffer holding other code than the
 * file is refused (the chain computes the proposal's hash from the buffer).
 */
export function proposePlan(so: string, code: Uint8Array, author: PublicKey, program: PublicKey, buffer: PublicKey | null, url: string | null, keypair: string | null = null, bufferCode: Uint8Array | null = null, priority: number | null = null): Step[] {
  const net = netFlags(url, keypair);
  const lock = timelockAddress(program);
  const steps: Step[] = [];
  if (!buffer) steps.push({ kind: 'shell', cmd: 'solana', args: ['program', 'write-buffer', so, ...priceFlags(priority), ...net], why: 'write the code to a buffer (prints its address: run propose again with --buffer)' });
  else {
    if (bufferCode && executableHash(bufferCode) !== executableHash(code)) throw new Error(`the buffer ${buffer.toBase58()} holds code ${executableHash(bufferCode)}, not ${so}'s ${executableHash(code)}`);
    steps.push({ kind: 'tx', ixs: [loader.setAuthority(buffer, author, lock)], why: `hand the buffer to the timelock ${lock.toBase58()} (nobody else can then write or close it)`, budget: { units: STEP_UNITS.setAuthority } });
    steps.push({ kind: 'tx', ixs: [timelock.propose(author, program, buffer, trimmedLength(code))], why: `propose code ${executableHash(code)} (${trimmedLength(code)} bytes)`, budget: { units: proposeUnits(Math.max(code.length, bufferCode?.length ?? 0)) } });
  }
  return steps;
}

function keypairFrom(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
}

/** Simulates `ixs` under a 1.4M limit (and the price): the units used, or null when it fails. */
async function simulateUnits(connection: Connection, signer: Keypair, ixs: TransactionInstruction[], priority: number | null): Promise<number | null> {
  const tx = new Transaction().add(...budgetIxs(MAX_COMPUTE_UNITS, priority), ...ixs);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const sim = await connection.simulateTransaction(tx, [signer]);
  return sim.value.err ? null : (sim.value.unitsConsumed ?? null);
}

async function run(steps: Step[], connection: Connection, signer: Keypair, print: boolean, priority: number | null = null): Promise<void> {
  for (const s of steps) {
    if (s.kind === 'shell') {
      process.stdout.write(`$ ${s.cmd} ${s.args.join(' ')}    # ${s.why}\n`);
      if (!print && !s.args.some((a) => a.startsWith('<'))) execFileSync(s.cmd, s.args, { stdio: 'inherit' });
    } else {
      process.stdout.write(`> ${s.why}\n`);
      for (const ix of s.ixs) process.stdout.write(`  ${ix.programId.toBase58()} ${ix.keys.length} accounts, ${ix.data.length} bytes\n`);
      const limit = 'units' in s.budget ? `${s.budget.units}` : `simulated (else ${s.budget.fallback})`;
      process.stdout.write(`  compute limit ${limit}${priority ? `, priority ${priority} µlamports/unit` : ''}\n`);
      if (!print) {
        const units = await stepUnits(s.budget, () => simulateUnits(connection, signer, s.ixs, priority));
        const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...budgetIxs(units, priority), ...s.ixs), [signer], { commitment: 'confirmed' });
        process.stdout.write(`  ${sig}\n`);
      }
    }
  }
}

/** The program's timelock and pending proposal, read from the chain. */
async function readTimelock(connection: Connection, program: PublicKey) {
  const info = await connection.getAccountInfo(timelockAddress(program), 'confirmed');
  const t = info ? decodeTimelock(Buffer.from(info.data)) : null;
  if (!t) throw new Error(`${program.toBase58()} has no timelock (register it with deploy --timelock)`);
  return t;
}

export async function main(argv: readonly string[]): Promise<void> {
  const a = parseArgs(argv);
  const print = a.flags.print === true;
  const priority = priorityFeeOf(a.flags['priority-fee']);
  const cli = typeof a.flags.url === 'string' && typeof a.flags.keypair === 'string' ? { url: null, keypair: null } : solanaConfig();
  const url = typeof a.flags.url === 'string' ? a.flags.url : (cli.url ?? 'https://api.mainnet-beta.solana.com');
  const keypairPath = typeof a.flags.keypair === 'string' ? a.flags.keypair : (cli.keypair ?? join(homedir(), '.config', 'solana', 'id.json'));
  const signer = print ? Keypair.generate() : keypairFrom(keypairPath);
  const connection = new Connection(url, 'confirmed');
  process.stdout.write(`cluster ${url} · signer ${print ? '(print only)' : signer.publicKey.toBase58()}\n`);
  const program = (): PublicKey => new PublicKey(str(a.flags.program, 'program'));
  switch (a.command) {
    case 'build': {
      const dir = typeof a.flags.dir === 'string' ? a.flags.dir : '.';
      const lib = typeof a.flags.lib === 'string' ? ['--library-name', a.flags.lib] : [];
      await run([{ kind: 'shell', cmd: 'solana-verify', args: ['build', '--arch', 'v3', '-b', 'solanafoundation/solana-verifiable-build:4.3.0', ...lib, dir], why: 'a verifiable build (Agave 4.3.0, SBPF v3)' }], connection, signer, print);
      return;
    }
    case 'sim': {
      // The simulator ships inside Studio's builder image (tools/studio-builder): pass its tag.
      const image = typeof a.flags.image === 'string' ? a.flags.image : process.env.BORDRLESS_SIM_IMAGE;
      if (!image) throw new Error('pass --image <Studio builder image> (or set BORDRLESS_SIM_IMAGE): the simulator is in tools/studio-builder');
      const dir = typeof a.flags.dir === 'string' ? a.flags.dir : '.';
      await run([{ kind: 'shell', cmd: 'docker', args: ['run', '--rm', '-v', `${dir}:/project`, image, a.kind === 'strategy' ? 'strategy' : 'hook', '/project'], why: 'Studio’s simulator, locally: a developer tool, not evidence' }], connection, signer, print);
      return;
    }
    case 'deploy': {
      const so = a.positional[0] ?? str(undefined, 'so');
      const programKeypair = str(a.flags['program-keypair'], 'program-keypair');
      const id = print ? Keypair.generate().publicKey : keypairFrom(programKeypair).publicKey;
      if (a.flags.immutable === true && a.flags.timelock !== undefined) throw new Error('choose --immutable or --timelock, not both');
      if (a.flags.immutable !== true && a.flags.timelock === undefined) throw new Error('a program here is immutable or timelocked: pass --immutable or --timelock <3d…365d> (an author-upgradeable program is refused by the launchpad and the companion)');
      const mode = a.flags.immutable === true ? ({ immutable: true } as const) : { delaySecs: parseDelay(str(a.flags.timelock, 'timelock')), author: typeof a.flags.author === 'string' ? new PublicKey(a.flags.author) : signer.publicKey };
      if (!('immutable' in mode) && !print && sbpfVersion(readFileSync(so)) !== 3) throw new Error(`${so} is not SBPF v3 code: build it with --arch v3 (a timelocked program must be able to go immutable)`);
      const [deploy, ...rest] = deployPlan(so, programKeypair, signer.publicKey, mode, id, url, keypairPath, priority);
      await run([deploy!], connection, signer, print, priority);
      try {
        await run(rest, connection, signer, print, priority);
      } catch (error) {
        const finish = 'immutable' in mode
          ? `solana program set-upgrade-authority ${id.toBase58()} --final --upgrade-authority ${keypairPath} --url ${url}`
          : `bordrless ${a.kind} register --program ${id.toBase58()} --timelock ${mode.delaySecs} --author ${mode.author.toBase58()} --keypair ${keypairPath} --url ${url}`;
        process.stderr.write(`The deploy landed but the next step failed: ${id.toBase58()} is still upgradeable by your keypair. Finish with:\n  ${finish}\n`);
        throw error;
      }
      return;
    }
    case 'propose': {
      const so = a.positional[0] ?? str(undefined, 'so');
      const buffer = typeof a.flags.buffer === 'string' ? new PublicKey(a.flags.buffer) : null;
      const code = readFileSync(so);
      if (sbpfVersion(code) !== 3) throw new Error(`${so} is not SBPF v3 code: build it with --arch v3`);
      const held = buffer ? await connection.getAccountInfo(buffer, 'confirmed') : null;
      if (buffer && !held && !print) throw new Error(`no buffer at ${buffer.toBase58()} on ${url}`);
      await run(proposePlan(so, code, signer.publicKey, program(), buffer, url, keypairPath, held ? Buffer.from(held.data).subarray(37) : null, priority), connection, signer, print, priority);
      return;
    }
    case 'execute':
    case 'expire':
    case 'cancel': {
      const p = program();
      const t = await readTimelock(connection, p);
      if (!t.pending) throw new Error('no proposal is pending');
      const ix = a.command === 'execute' ? timelock.execute(signer.publicKey, p, t.pending.buffer, t.author) : a.command === 'expire' ? timelock.expire(signer.publicKey, p, t.pending.buffer, t.author) : timelock.cancel(signer.publicKey, p, t.pending.buffer);
      const steps: Step[] = [];
      if (a.command === 'execute') {
        const [buf, pd] = await connection.getMultipleAccountsInfo([t.pending.buffer, programDataAddress(p)], 'confirmed');
        const grow = buf && pd ? buf.data.length - 37 - (pd.data.length - 45) : 0;
        if (grow > 0) steps.push({ kind: 'tx', ixs: [loader.extendProgram(programDataAddress(p), p, signer.publicKey, Math.max(grow, 10_240))], why: `extend the ProgramData by ${Math.max(grow, 10_240)} bytes first (anyone may; you pay the rent)`, budget: { simulate: true, fallback: MAX_COMPUTE_UNITS } });
      }
      // `execute` runs the loader's upgrade, whose verification follows the code's size: simulated.
      const budget: Budget = a.command === 'execute' ? { simulate: true, fallback: MAX_COMPUTE_UNITS } : { units: STEP_UNITS.timelock };
      steps.push({ kind: 'tx', ixs: [ix], why: `${a.command} the proposal of ${t.pending.hash}`, budget });
      await run(steps, connection, signer, print, priority);
      return;
    }
    case 'register': {
      const author = typeof a.flags.author === 'string' ? new PublicKey(a.flags.author) : signer.publicKey;
      const delaySecs = parseDelay(str(a.flags.timelock, 'timelock'));
      await run([{ kind: 'tx', ixs: [timelock.register(signer.publicKey, signer.publicKey, program(), delaySecs, author)], why: `put it behind hook_timelock (${delaySecs / 86_400} days, author ${author.toBase58()})`, budget: { units: STEP_UNITS.register } }], connection, signer, print, priority);
      return;
    }
    case 'finalize':
      await run([{ kind: 'tx', ixs: [timelock.finalize(signer.publicKey, program())], why: 'make it immutable, at once (no proposal may be pending)', budget: { units: STEP_UNITS.timelock } }], connection, signer, print, priority);
      return;
    case 'lengthen':
      await run([{ kind: 'tx', ixs: [timelock.lengthen(signer.publicKey, program(), parseDelay(str(a.flags.delay, 'delay')))], why: 'lengthen the delay (never shorter)', budget: { units: STEP_UNITS.timelock } }], connection, signer, print, priority);
      return;
    case 'status': {
      const l = await hookRiskLabel(connection, program());
      process.stdout.write(`${l.class} · ${l.severity} · ${l.words}\n`);
      return;
    }
    case 'verify': {
      const api = typeof a.flags.api === 'string' ? a.flags.api : 'https://api.bordrless.com';
      const body = { kind: a.kind, program: program().toBase58(), commit: str(a.flags.commit, 'commit'), source: str(a.flags.source, 'source') };
      process.stdout.write(`POST ${api}/v1/studio/verify ${JSON.stringify(body)}\n`);
      if (!print) {
        const res = await fetch(`${api}/v1/studio/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        process.stdout.write(`${res.status} ${await res.text()}\n`);
      }
      return;
    }
    default:
      throw new Error(`unknown command: ${a.command}`);
  }
}

if (process.argv[1] && /bordrless(\.ts|\.js)?$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
