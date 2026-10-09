/**
 * The launch program’s rule on a config’s own hook (§5.8), as `inspectConfig` and `inspectTokenHook`
 * read it: immutable, or upgradeable only by Bordrless Studio’s key or the protocol’s.
 */
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { HOOK_AUTHORITY_PROBLEM, PROTOCOL_UPGRADE_AUTHORITY, RULE_BOUNDS, STUDIO_UPGRADE_AUTHORITY, TOKEN_SUPPLY } from '@bordrless/shared';
import { BPF_LOADER_UPGRADEABLE, BRIDGED_SOL_MINT, LAUNCH_CONFIG, LAUNCH_PROGRAM, TAX_HOOK_PROGRAM, programDataAddress } from './addresses.ts';
import { NO_LAUNCH_RULES } from './accounts.ts';
import { CODERS } from './coders.ts';
import { hookAcceptedBy, inspectConfig, inspectTokenHook } from './inspect.ts';
import { TAX_HOOK_FLAGS } from './instructions.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const bn = (v: bigint | number): BN => new BN(v.toString());
const STUDIO = new PublicKey(STUDIO_UPGRADE_AUTHORITY);
const PROTOCOL = new PublicKey(PROTOCOL_UPGRADE_AUTHORITY);
const info = (owner: PublicKey, data: Buffer, executable = false): AccountInfo<Buffer> => ({ owner, data, executable, lamports: 1, rentEpoch: 0 });

/** A program under the upgradeable loader and its ProgramData naming `authority` (null: final). */
function deployed(program: PublicKey, authority: PublicKey | null): [AccountInfo<Buffer>, AccountInfo<Buffer>] {
  const data = Buffer.alloc(45);
  data.writeUInt32LE(3, 0);
  if (authority) {
    data[12] = 1;
    authority.toBuffer().copy(data, 13);
  }
  return [info(BPF_LOADER_UPGRADEABLE, Buffer.concat([Buffer.from([2, 0, 0, 0]), programDataAddress(program).toBuffer()]), true), info(BPF_LOADER_UPGRADEABLE, data)];
}

async function chain(hook: PublicKey | null, authority: PublicKey | null): Promise<{ connection: Connection; config: PublicKey }> {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const admin = k();
  const launch = await CODERS.launch.accounts.encode('config', {
    version: 1, bump: 255, admin, treasury: admin, quoteMint: BRIDGED_SOL_MINT, launchFeeLamports: bn(10_000_000n), lpFeeBps: 30, maxCreatorFeeBps: 200, sniperWindowSecs: bn(30), sniperStartBps: 8_000, curveBps: 7_500,
    supply: bn(TOKEN_SUPPLY), decimals: 6, minVirtualQuote: bn(1_000_000_000n), maxVirtualQuote: bn(10_000_000_000_000n), paused: false, launches: bn(0), ruleBounds: { ...RULE_BOUNDS }, reserved: Array(64).fill(0),
  });
  accounts.set(LAUNCH_CONFIG.toBase58(), info(LAUNCH_PROGRAM, launch));
  const config = k();
  const bytes = await CODERS.launch.accounts.encode('launchConfig', { version: 1, creator: k(), rules: { ...NO_LAUNCH_RULES }, creatorFeeBps: 100, customHook: hook, customHookFlags: hook ? TAX_HOOK_FLAGS : 0, label: 'taxed', createdAt: bn(1_800_000_000), authorShareBps: 0, reserved: Array(30).fill(0) });
  accounts.set(config.toBase58(), info(LAUNCH_PROGRAM, Buffer.concat([bytes, Buffer.alloc(Math.max(0, 176 - bytes.length))])));
  if (hook) {
    const [program, programData] = deployed(hook, authority);
    accounts.set(hook.toBase58(), program);
    accounts.set(programDataAddress(hook).toBase58(), programData);
  }
  const connection = { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) => accounts.get(key.toBase58()) ?? null) } as unknown as Connection;
  return { connection, config };
}

describe('who may upgrade a config’s own hook', () => {
  it('passes a config without a hook', async () => {
    const { connection, config } = await chain(null, null);
    expect(await inspectConfig(connection, config)).toMatchObject({ problems: [], hookAccepted: true, hook: null });
  });

  it('passes an immutable hook, and one Studio’s key or the protocol’s can upgrade', async () => {
    for (const authority of [null, STUDIO, PROTOCOL]) {
      const { connection, config } = await chain(TAX_HOOK_PROGRAM, authority);
      expect(await inspectConfig(connection, config)).toMatchObject({ problems: [], hookAccepted: true });
    }
  });

  it('refuses a hook another key can upgrade, in one sentence', async () => {
    const other = await chain(TAX_HOOK_PROGRAM, k());
    expect(await inspectConfig(other.connection, other.config)).toMatchObject({ problems: [HOOK_AUTHORITY_PROBLEM], hookAccepted: false });
    // With a mint the hook was never prepared for: still that one sentence, not the registry's too.
    expect(await inspectConfig(other.connection, other.config, k())).toMatchObject({ problems: [HOOK_AUTHORITY_PROBLEM], registryReady: false });
  });

  it('tells a hook’s author what to do before a config is made', async () => {
    const other = k();
    const { connection } = await chain(TAX_HOOK_PROGRAM, other);
    const seen = await inspectTokenHook(connection, TAX_HOOK_PROGRAM, k());
    expect(seen.accepted).toBe(false);
    expect(seen.problems.some((p) => p.includes(other.toBase58()) && p.includes('--final'))).toBe(true);
    const studio = await chain(TAX_HOOK_PROGRAM, STUDIO);
    expect((await inspectTokenHook(studio.connection, TAX_HOOK_PROGRAM, k())).accepted).toBe(true);
  });

  it('holds keys as the shared rule holds addresses', () => {
    const hook = k();
    expect(hookAcceptedBy(null, null)).toBe(true);
    expect(hookAcceptedBy(hook, { executable: true, upgradeAuthority: STUDIO, upgradeable: true })).toBe(true);
    expect(hookAcceptedBy(hook, { executable: true, upgradeAuthority: PROTOCOL, upgradeable: true })).toBe(true);
    expect(hookAcceptedBy(hook, { executable: true, upgradeAuthority: null, upgradeable: false })).toBe(true);
    expect(hookAcceptedBy(hook, { executable: true, upgradeAuthority: k(), upgradeable: true })).toBe(false);
    expect(hookAcceptedBy(hook, { executable: false, upgradeAuthority: null, upgradeable: null })).toBe(true);
    expect(hookAcceptedBy(hook, null)).toBe(true);
  });
});
