/**
 * Approvals' and script companions' builders, addresses, decoders and bounds held to the program:
 * `vectors/scripts.json`, which bordrless-programs' `script_vectors.rs` renders from
 * `bordrless_companion::client` and the account layouts (`Approval`, `Script`), with a script
 * companion's fee claim (its author paid, or not) and a Snowball step of a custom-hook token.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey, type AccountInfo, type AccountMeta, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { STUDIO_UPGRADE_AUTHORITY } from '@bordrless/shared';
import vectors from '../vectors/scripts.json' with { type: 'json' };
import * as a from './addresses.ts';
import { PROGRAMDATA_HEADER_LEN, executableHash } from './authority.ts';
import { CODERS, IDL } from './coders.ts';
import { companion, decodeCompanion } from './companion.ts';
import { EVENT_IX_TAG, GAME_EVENT_PROGRAMS, INDEXED_EVENT_PROGRAMS, eventsOf } from './events.ts';
import type { CustomHookAccounts } from './hooks.ts';
import type { LaunchKeys } from './instructions.ts';
import { APPROVAL_KINDS, COMPANION_INIT_DISCRIMINATOR, COMPANION_STEP_DISCRIMINATOR, MODE_SCRIPT, SCRIPT_LIMITS, decodeApproval, decodeScript, inspectScriptProgram, scriptClaimAuthor, scriptDue, scriptInitDataBytes, scriptNextStepAt, scriptProgramStatusOf, type ScriptArgs } from './scripts.ts';

/** The Rust vectors' `key(n)`: 32 bytes of `n`. */
const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
const K = { payer: key(1), cranker: key(2), authority: key(3), author: key(5), mint: key(7), program: key(9) };
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const keys = (modules: number, burns: boolean, customHook: CustomHookAccounts | null = null): LaunchKeys => ({ mint: K.mint, quoteMint: a.BRIDGED_SOL_MINT, lpFeeBps: 30, modules, burns, customHook });
/** `script_vectors.rs` `terms()`. */
const terms: ScriptArgs = { split: { buybackBps: 1_000, holdersBps: 0, beneficiaryBps: 2_000 }, potBps: 7_000, program: K.program, interval: 60, stateLen: 1_024, initData: Uint8Array.from([1, 2, 3]) };
/** A custom hook's accounts for a Snowball's buys and for its sells (made up, as in the vectors). */
const hook = key(12);
const buy: CustomHookAccounts = { program: hook, extras: [rw(key(13)), ro(key(14))] };
const sell: CustomHookAccounts = { program: hook, extras: [rw(key(15))] };

type Row = [string, boolean, boolean];
const asVector = (name: string, ix: TransactionInstruction) => ({
  name,
  program: ix.programId.toBase58(),
  accounts: ix.keys.map((m): Row => [m.pubkey.toBase58(), m.isSigner, m.isWritable]),
  data: ix.data.toString('hex'),
});
const byName = (name: string) => vectors.instructions.find((v) => v.name === name)!;
/** A decoded account with its keys as base58. */
const plain = (o: object): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof PublicKey ? v.toBase58() : v]));

it('the vectors’ keys are the Rust key(n)', () => {
  expect(Object.fromEntries(Object.entries(K).map(([k, v]) => [k, v.toBase58()]))).toEqual(vectors.keys);
});

describe('the builders are the Rust client’s', () => {
  const ours: Record<string, TransactionInstruction> = {
    approve: companion.approve(K.authority, K.program, APPROVAL_KINDS.script, 'ab'.repeat(32), K.author),
    revokeApproval: companion.revokeApproval(K.authority, K.program),
    // The script's init takes one account of its own (`key(10)`) after its four (`[creator, mint, state, system program]`).
    createScript: companion.createScript(K.payer, K.mint, terms, [rw(key(10))]),
    // A script that asks for no state: its address is passed all the same (the script gets the system program's id in its place).
    createScriptNoState: companion.createScript(K.payer, K.mint, { ...terms, stateLen: 0 }, []),
    // The script's step takes two accounts of its own after its six (`[creator, mint, launch, companion, pool, state]`).
    scriptStep: companion.scriptStep(K.cranker, keys(0, false), K.program, [ro(key(10)), rw(key(11))]),
    scriptStepKit: companion.scriptStep(K.cranker, keys(1, true), K.program, []),
    claimFeesScript: companion.claimFeesScript(K.cranker, K.mint, K.author),
    claimFeesScriptNoAuthor: companion.claimFeesScript(K.cranker, K.mint, null),
    snowballStepCustomHook: companion.snowballStep(K.cranker, keys(0, false, buy), sell),
  };
  it('covers every instruction the vectors hold', () => {
    expect(Object.keys(ours).sort()).toEqual(vectors.instructions.map((v) => v.name).sort());
  });
  for (const v of vectors.instructions) {
    it(`${v.name}: the same program, accounts and data`, () => {
      expect(asVector(v.name, ours[v.name]!)).toEqual(v);
    });
  }

  it('agrees with the IDL: discriminators, and each named account’s flags and fixed address', () => {
    type IdlIx = { name: string; discriminator: number[]; accounts: { name: string; signer?: boolean; writable?: boolean; address?: string }[] };
    const idl = (IDL.companion as unknown as { instructions: IdlIx[] }).instructions;
    const pairs: [string, TransactionInstruction][] = [
      ['approve', ours.approve!],
      ['revoke_approval', ours.revokeApproval!],
      ['create_script', ours.createScript!],
      ['script_step', ours.scriptStep!],
    ];
    for (const [name, ix] of pairs) {
      const def = idl.find((i) => i.name === name)!;
      expect([...ix.data.subarray(0, 8)], name).toEqual(def.discriminator);
      def.accounts.forEach((acc, i) => {
        const m = ix.keys[i]!;
        expect([acc.name, m.isSigner, m.isWritable], `${name}[${i}]`).toEqual([acc.name, acc.signer === true, acc.writable === true]);
        if (acc.address) expect(m.pubkey.toBase58(), `${name}[${i}] address`).toBe(acc.address);
        if (acc.name === 'event_authority') expect(m.pubkey.equals(a.COMPANION_EVENT_AUTHORITY), `${name}[${i}]`).toBe(true);
        if (acc.name === 'program') expect(m.pubkey.equals(a.COMPANION_PROGRAM), `${name}[${i}]`).toBe(true);
      });
    }
  });

  it('a script companion’s claim is the plain claim, then its script and the author’s wallet', () => {
    const plainClaim = companion.claimFees(K.cranker, K.mint).keys.map((m): Row => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);
    expect(byName('claimFeesScript').accounts).toEqual([...plainClaim, [vectors.scriptAddress, false, true], [K.author.toBase58(), false, true]]);
    expect(byName('claimFeesScriptNoAuthor').accounts).toEqual([...plainClaim, [vectors.scriptAddress, false, true]]);
  });

  it('one custom hook’s accounts serve a Snowball’s buys and sells alike (client::snowball_step_with)', () => {
    // Given once (as the token's hook or as the sell's), its extras go on the swap and again for a sell.
    const once = asVector('snowballStepCustomHook', companion.snowballStep(K.cranker, keys(0, false, buy)));
    expect(asVector('snowballStepCustomHook', companion.snowballStep(K.cranker, keys(0, false), buy))).toEqual(once);
    const vector = byName('snowballStepCustomHook').accounts as Row[];
    const at = vector.findIndex((r) => r[0] === key(15).toBase58());
    const asBuy = buy.extras.map((m): Row => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);
    expect(once.accounts).toEqual([...vector.slice(0, at), ...asBuy, ...vector.slice(at + 1)]);
    expect(() => companion.snowballStep(K.cranker, keys(0, false, buy), { program: key(16), extras: [] })).toThrow(/another program/);
  });

  it('derives the approval, script and script state addresses as the program does', () => {
    expect(a.approvalAddress(K.program).toBase58()).toBe(vectors.approvalAddress);
    expect(a.scriptAddress(K.mint).toBase58()).toBe(vectors.scriptAddress);
    expect(a.scriptStateAddress(K.mint).toBase58()).toBe(vectors.scriptStateAddress);
  });
});

describe('the accounts', () => {
  const approvalData = (): Buffer => Buffer.from(vectors.accounts.approval.data, 'hex');
  const scriptData = (): Buffer => Buffer.from(vectors.accounts.script.data, 'hex');

  it('decodes an Approval as the program serializes it', () => {
    const v = vectors.accounts.approval;
    const data = approvalData();
    expect([data.length, CODERS.companion.accounts.size('approval')]).toEqual([v.len, v.len]);
    expect(data.subarray(0, 8).toString('hex')).toBe(v.discriminator);
    expect(plain(decodeApproval(data))).toEqual({
      version: 1,
      bump: 253,
      program: K.program.toBase58(),
      kind: APPROVAL_KINDS.script,
      codeHash: 'ab'.repeat(32),
      approvedAt: 1_760_000_000,
      revoked: false,
      updatedBy: K.authority.toBase58(),
      programdataSlot: 400_000_123n,
      author: K.author.toBase58(),
    });
  });

  it('decodes a Script as the program serializes it', () => {
    const v = vectors.accounts.script;
    const data = scriptData();
    expect([data.length, CODERS.companion.accounts.size('script')]).toEqual([v.len, v.len]);
    expect(data.subarray(0, 8).toString('hex')).toBe(v.discriminator);
    expect(plain(decodeScript(data))).toEqual({
      version: 1,
      bump: 252,
      mint: K.mint.toBase58(),
      program: K.program.toBase58(),
      interval: 60,
      lastAt: 1_760_000_600,
      steps: 42n,
      createdAt: 1_759_990_000,
      author: K.author.toBase58(),
      authorPaid: 1_234_567_890n,
      stateLen: 1_024,
    });
    // `state_len` sits at 146, after `author_paid`, taken from what was `reserved`.
    expect(data.readUInt32LE(146)).toBe(1_024);
  });

  it('reads an author of the default key as none, and has a claim pass the author only when it pays them', () => {
    // The author sits after `programdata_slot` in an Approval, after `created_at` in a Script.
    const noAuthor = (data: Buffer, at: number): Buffer => {
      expect(data.indexOf(K.author.toBuffer())).toBe(at);
      return data.fill(0, at, at + 32);
    };
    expect(decodeApproval(noAuthor(approvalData(), 124)).author).toBeNull();
    const none = decodeScript(noAuthor(scriptData(), 106));
    expect(none.author).toBeNull();
    const s = decodeScript(scriptData());
    expect(scriptClaimAuthor(s, { beneficiary: K.payer })?.toBase58()).toBe(K.author.toBase58());
    expect(scriptClaimAuthor(s, { beneficiary: K.author })).toBeNull();
    expect(scriptClaimAuthor(none, { beneficiary: K.payer })).toBeNull();
  });

  it('reads a companion of mode 2 as a script companion (and 1 as a Snowball)', () => {
    const disc = (IDL.companion as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((x) => x.name === 'Companion')!.discriminator;
    const size = CODERS.companion.accounts.size('companion');
    // `mode` is the account's last byte; the rest zeros, as a fresh classic companion's.
    const of = (mode: number): Buffer => {
      const b = Buffer.alloc(size);
      Buffer.from(disc).copy(b);
      b[size - 1] = mode;
      return b;
    };
    const modes = [0, 1, MODE_SCRIPT].map((m) => {
      const c = decodeCompanion(of(m));
      return [c.snowball, c.script];
    });
    expect(modes).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
  });
});

describe('the bounds, the script’s interface and the events', () => {
  it('holds the program’s constants', () => {
    const c = vectors.constants;
    expect([MODE_SCRIPT, APPROVAL_KINDS.tokenHook, APPROVAL_KINDS.script]).toEqual([c.modeScript, c.approvalKindTokenHook, c.approvalKindScript]);
    const L = SCRIPT_LIMITS;
    expect([L.minInterval, L.maxInterval, L.maxInitLen, L.maxStateLen, L.bounty.toString(), L.afterLaunchSecs, L.authorShareBps]).toEqual([c.minInterval, c.maxInterval, c.maxInitLen, c.maxStateLen, c.bounty, c.afterLaunch, c.authorShareBps]);
    expect([COMPANION_INIT_DISCRIMINATOR.toString('hex'), COMPANION_STEP_DISCRIMINATOR.toString('hex')]).toEqual([c.initDiscriminator, c.stepDiscriminator]);
  });

  it('names the script’s two instructions as Anchor does', () => {
    const anchorName = (name: string): string => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
    expect([anchorName('companion_init'), anchorName('companion_step')]).toEqual([COMPANION_INIT_DISCRIMINATOR.toString('hex'), COMPANION_STEP_DISCRIMINATOR.toString('hex')]);
  });

  it('knows the new events by the program’s discriminators', () => {
    const events = (IDL.companion as unknown as { events: { name: string; discriminator: number[] }[] }).events;
    for (const [name, disc] of Object.entries(vectors.events)) {
      expect(Buffer.from(events.find((e) => e.name === name)?.discriminator ?? []).toString('hex'), name).toBe(disc);
    }
  });

  it('decodes an author’s payment and a script step laid out as the program emits them', () => {
    const u64 = (v: bigint): Buffer => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(v);
      return b;
    };
    const decode = (event: string, body: Buffer[]) => {
      const data = Buffer.concat([EVENT_IX_TAG, Buffer.from(event, 'hex'), ...body]).toString('base64');
      const accountKeys = [a.COMPANION_PROGRAM.toBase58(), a.COMPANION_EVENT_AUTHORITY.toBase58()];
      return eventsOf(accountKeys, [{ programIdIndex: 0, accounts: [1], data }], (d) => Buffer.from(d, 'base64'), [...INDEXED_EVENT_PROGRAMS, ...GAME_EVENT_PROGRAMS]);
    };
    const companionKey = a.companionAddress(K.mint);
    // `AuthorPaid { companion, author, amount }`.
    const [paid] = decode(vectors.events.AuthorPaid, [companionKey.toBuffer(), K.author.toBuffer(), u64(1_234n)]);
    expect([paid?.program, paid?.name, paid?.data]).toEqual(['companion', 'authorPaid', { companion: companionKey.toBase58(), author: K.author.toBase58(), amount: '1234' }]);
    // `ScriptStepped { companion, program, sol_before, sol_after, tokens_before, tokens_after, bounty, pot_after, cranker }`.
    const [stepped] = decode(vectors.events.ScriptStepped, [companionKey.toBuffer(), K.program.toBuffer(), ...[10n, 8n, 0n, 5n, 20_000n, 7n].map(u64), K.cranker.toBuffer()]);
    expect(stepped?.data).toEqual({
      companion: companionKey.toBase58(),
      program: K.program.toBase58(),
      solBefore: '10',
      solAfter: '8',
      tokensBefore: '0',
      tokensAfter: '5',
      bounty: '20000',
      potAfter: '7',
      cranker: K.cranker.toBase58(),
    });
  });
});

// ---- from your own terminal: stepping, the init data, and what the chain says of a script program ----

describe('stepping a script', () => {
  const c = { launched: true, launchedAt: 1_760_000_000 };
  it('is due a minute after the launch at the earliest, then an interval after the last step', () => {
    expect(scriptNextStepAt(c, { lastAt: 0, interval: 60 })).toBe(1_760_000_060);
    expect(scriptNextStepAt(c, { lastAt: 1_760_000_600, interval: 60 })).toBe(1_760_000_660);
    expect(scriptDue(c, { lastAt: 0, interval: 60 }, 1_760_000_059)).toBe(false);
    expect(scriptDue(c, { lastAt: 0, interval: 60 }, 1_760_000_060)).toBe(true);
    expect(scriptDue({ launched: false, launchedAt: 0 }, { lastAt: 0, interval: 60 }, 1_760_000_060)).toBe(false);
  });

  it('reads the launch request’s init data as hex or base64, the empty string as none', () => {
    expect([...scriptInitDataBytes('')]).toEqual([]);
    expect([...scriptInitDataBytes('010203')]).toEqual([1, 2, 3]);
    expect([...scriptInitDataBytes('0x010203')]).toEqual([1, 2, 3]);
    expect([...scriptInitDataBytes(Buffer.from([1, 2, 3]).toString('base64'))]).toEqual([1, 2, 3]);
    expect(() => scriptInitDataBytes('not bytes!')).toThrow(/hex or base64/);
    expect(() => scriptInitDataBytes('00'.repeat(SCRIPT_LIMITS.maxInitLen + 1))).toThrow(/512/);
  });
});

describe('what the chain says of a script program', () => {
  const k = (): PublicKey => Keypair.generate().publicKey;
  const bn = (v: bigint | number): BN => new BN(v.toString());
  const info = (owner: PublicKey, data: Buffer, executable = false): AccountInfo<Buffer> => ({ owner, data, executable, lamports: 1, rentEpoch: 0 });
  const code = Buffer.from([7, 7, 7, 0, 0, 0]);
  const codeHash = executableHash(code);
  const program = k();
  const author = k();
  const studio = new PublicKey(STUDIO_UPGRADE_AUTHORITY);

  /** An upgradeable-loader program and its ProgramData at `slot` under `authority` (null: immutable), with the code after the header when `withCode`. */
  const deployed = (slot: bigint, authority: PublicKey | null, withCode = true): [AccountInfo<Buffer>, AccountInfo<Buffer>] => {
    const header = Buffer.alloc(PROGRAMDATA_HEADER_LEN);
    header.writeUInt32LE(3, 0);
    header.writeBigUInt64LE(slot, 4);
    if (authority) {
      header[12] = 1;
      authority.toBuffer().copy(header, 13);
    }
    const data = withCode ? Buffer.concat([header, code]) : header;
    return [info(a.BPF_LOADER_UPGRADEABLE, Buffer.concat([Buffer.from([2, 0, 0, 0]), a.programDataAddress(program).toBuffer()]), true), info(a.BPF_LOADER_UPGRADEABLE, data)];
  };
  const approval = async (over: Partial<{ kind: number; revoked: boolean; slot: bigint; hash: string; of: PublicKey }> = {}): Promise<AccountInfo<Buffer>> => {
    const data = await CODERS.companion.accounts.encode('approval', {
      version: 1, bump: 250, program: over.of ?? program, kind: over.kind ?? APPROVAL_KINDS.script, codeHash: [...Buffer.from(over.hash ?? codeHash, 'hex')], approvedAt: bn(1_760_000_000), revoked: over.revoked ?? false,
      updatedBy: studio, programdataSlot: bn(over.slot ?? 400n), author, reserved: Array(24).fill(0),
    });
    return info(a.COMPANION_PROGRAM, data);
  };

  it('finds a program that is not deployed, or not on the upgradeable loader', async () => {
    expect(scriptProgramStatusOf(program, null, null, null)).toMatchObject({ immutable: false, approval: null, approvalHolds: null, lane: null, problems: ['The script program is not deployed on this cluster.'] });
    const loader2 = info(new PublicKey('BPFLoader2111111111111111111111111111111111'), code, true);
    expect(scriptProgramStatusOf(program, loader2, null, await approval()).problems).toEqual(['The script program is not deployed through the upgradeable loader: the companion program reads its ProgramData.']);
  });

  it('takes an immutable program with no approval: the self-serve lane, no author', async () => {
    const [p, pd] = deployed(400n, null);
    const seen = scriptProgramStatusOf(program, p, pd, await approval({ revoked: true }));
    expect(seen).toMatchObject({ immutable: true, lane: 'self-serve', approvalHolds: null, author: null, problems: [] });
    expect(seen.info.upgradeable).toBe(false);
  });

  it('holds an approval while the ProgramData slot is the approved one, and names the author', async () => {
    const [p, pd] = deployed(400n, studio, false);
    const seen = scriptProgramStatusOf(program, p, pd, await approval());
    expect(seen).toMatchObject({ immutable: false, approvalHolds: true, lane: 'workshop', problems: [], codeHash: null });
    expect(seen.author?.equals(author)).toBe(true);
    expect(seen.approval?.codeHash).toBe(codeHash);
  });

  it('hashes the code again once the slot moved: the same code still holds, other code does not, and a header alone cannot tell', async () => {
    const [p, pd] = deployed(401n, studio);
    expect(scriptProgramStatusOf(program, p, pd, await approval())).toMatchObject({ approvalHolds: true, codeHash, lane: 'workshop', problems: [] });
    const other = await approval({ hash: 'ab'.repeat(32) });
    expect(scriptProgramStatusOf(program, p, pd, other)).toMatchObject({ approvalHolds: false, lane: null, problems: ['The script’s code changed since Bordrless approved it: the approval does not hold until the new code is approved.'] });
    const [, header] = deployed(401n, studio, false);
    expect(scriptProgramStatusOf(program, p, header, other)).toMatchObject({ approvalHolds: null, lane: null, problems: [] });
  });

  it('says why a program a key can still upgrade is refused: no approval, revoked, or approved as a hook', async () => {
    const [p, pd] = deployed(400n, studio);
    const none = scriptProgramStatusOf(program, p, pd, null);
    expect(none.approvalHolds).toBe(false);
    expect(none.problems[0]).toContain(`solana program set-upgrade-authority ${program.toBase58()} --final`);
    expect(none.problems[0]).toContain('submit it to the Workshop');
    // Another program's approval at the address is not this program's.
    expect(scriptProgramStatusOf(program, p, pd, await approval({ of: k() }))).toMatchObject({ approval: null, approvalHolds: false });
    expect(scriptProgramStatusOf(program, p, pd, await approval({ revoked: true })).problems).toEqual(['Bordrless revoked this script’s approval: no launch takes it and its steps stop.']);
    expect(scriptProgramStatusOf(program, p, pd, await approval({ kind: APPROVAL_KINDS.tokenHook })).problems).toEqual(['This program is approved as a token hook, not as a companion script.']);
  });

  it('reads the header first and the whole ProgramData only when the slot moved', async () => {
    const [p, pd] = deployed(401n, studio);
    const approved = await approval();
    const reads: number[] = [];
    const connection = {
      getAccountInfo: async (key: PublicKey, opts: { dataSlice?: { length: number } } | string) => {
        if (key.equals(program)) return p;
        if (key.equals(a.approvalAddress(program))) return approved;
        if (key.equals(a.programDataAddress(program))) {
          const slice = typeof opts === 'object' && opts.dataSlice ? opts.dataSlice.length : null;
          reads.push(slice ?? pd.data.length);
          return slice ? { ...pd, data: pd.data.subarray(0, slice) } : pd;
        }
        return null;
      },
    } as unknown as Connection;
    expect(await inspectScriptProgram(connection, program)).toMatchObject({ approvalHolds: true, lane: 'workshop', codeHash });
    expect(reads).toEqual([PROGRAMDATA_HEADER_LEN, pd.data.length]);
    // An immutable program: one read of the header is enough.
    const [p2, pd2] = deployed(500n, null);
    const immutable = { getAccountInfo: async (key: PublicKey) => (key.equals(program) ? p2 : key.equals(a.programDataAddress(program)) ? { ...pd2, data: pd2.data.subarray(0, PROGRAMDATA_HEADER_LEN) } : null) } as unknown as Connection;
    expect(await inspectScriptProgram(immutable, program)).toMatchObject({ immutable: true, lane: 'self-serve', problems: [] });
  });
});
