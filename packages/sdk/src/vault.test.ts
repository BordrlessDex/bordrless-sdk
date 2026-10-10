/**
 * `hook_vault` held to the Rust reference, byte for byte: `vectors/vault.json`, which
 * bordrless-programs' `vault_vectors.rs` renders from `hook_vault::client` and the program's own
 * serialization of a `Vault`.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey, type AccountMeta, type TransactionInstruction } from '@solana/web3.js';
import vectors from '../vectors/vault.json' with { type: 'json' };
import * as a from './addresses.ts';
import { PROGRAM_ERRORS, explainProgramError } from './errors.ts';
import type { CustomHookAccounts } from './hooks.ts';
import type { LaunchKeys } from './instructions.ts';
import { HOOK_VAULT_EVENT_AUTHORITY, VAULT_LIMITS, decodeVault, hookVaultAddress, slotHolding, slotOwner, vault, vaultIsCreatorTax, vaultLaunchSequence, vaultPolicyWords, vaultViewOf, type CreateVaultArgs } from './vault.ts';

const key = (s: string): PublicKey => new PublicKey(s);
const asVector = (name: string, ix: TransactionInstruction) => ({
  name,
  program: ix.programId.toBase58(),
  accounts: ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]),
  data: ix.data.toString('hex'),
});
const byName = (name: string) => {
  const v = vectors.instructions.find((x) => x.name === name);
  if (!v) throw new Error(`no vector ${name}`);
  return v;
};
const metas = (list: (string | boolean)[][]): AccountMeta[] => list.map(([k, s, w]) => ({ pubkey: key(k as string), isSigner: s as boolean, isWritable: w as boolean }));
const keysOf = (l: { mint: string; quoteMint: string; lpFeeBps: number; modules: number; burns: boolean }, customHook: CustomHookAccounts | null = null): LaunchKeys => ({ mint: key(l.mint), quoteMint: key(l.quoteMint), lpFeeBps: l.lpFeeBps, modules: l.modules, burns: l.burns, customHook });

describe('hook_vault builders are the Rust client’s', () => {
  const k = vectors.keys;
  const [payer, mint, hook, cranker, wallet, xPool, xHook] = [key(k.payer), key(k.mint), key(k.hook), key(k.cranker), key(k.wallet), key(k.xPool), key(k.xHook)] as const;
  const v = decodeVault(Buffer.from(vectors.accounts[0]!.data, 'hex'));
  const h = vectors.hooks;
  const sale: CustomHookAccounts = { program: hook, extras: metas(h.sale) };
  const burn: CustomHookAccounts = { program: hook, extras: metas(h.burn) };
  const xTransfer: CustomHookAccounts = { program: xHook, extras: metas(h.xTransfer) };
  const xBurn: CustomHookAccounts = { program: xHook, extras: metas(h.xBurn) };
  const l = vectors.launches;
  const coin = keysOf(l.coin, sale);
  const xKit = keysOf(l.xKit);
  const args: CreateVaultArgs = {
    hook,
    slots: [{ policy: 'burn' }, { policy: 'sellForSol', target: wallet }, { policy: 'sellBuyBurn', target: xPool, maxCutBps: 300 }],
    bountyBps: 50,
    maxSellBps: 100,
    interval: 3_600,
    maxHookCutBps: 200,
  };
  const noPending = { ...v, slots: v.slots.map((s, i) => (i === 2 ? { ...s, pendingSol: 0n } : s)) };
  const ours: Record<string, TransactionInstruction> = {
    createVault: vault.createVault(payer, mint, args, [xKit.mint]),
    openVault: vault.openVault(payer, v, coin),
    executeBurn: vault.execute(cranker, v, 0, coin, burn),
    executeSellForSol: vault.execute(cranker, v, 1, coin, sale),
    executeSellToBuy: vault.execute(cranker, v, 2, coin, sale),
    executeBuyKit: vault.executeBuy(cranker, v, 2, xKit, { kind: 'kit', rewards: false }),
    executeBuyPlain: vault.executeBuy(cranker, v, 2, keysOf(l.xPlain), { kind: 'kit', rewards: false }),
    executeBuyCustom: vault.executeBuy(cranker, v, 2, keysOf(l.xCustom), { kind: 'custom', transfer: xTransfer, burn: xBurn }),
    retireSolAndCoin: vault.retire(cranker, v, 2, true, burn),
    retireSolOnly: vault.retire(cranker, v, 2, false),
    retireCoinOnly: vault.retire(cranker, noPending, 1, true, burn),
  };
  it('covers every vector', () => expect(Object.keys(ours).sort()).toEqual(vectors.instructions.map((x) => x.name).sort()));
  for (const [name, ix] of Object.entries(ours)) {
    it(name, () => expect(asVector(name, ix)).toEqual(byName(name)));
  }

  it('derives the addresses and holds the bounds', () => {
    const c = vectors.constants;
    expect(a.HOOK_VAULT_PROGRAM.toBase58()).toBe(c.programId);
    expect(HOOK_VAULT_EVENT_AUTHORITY.toBase58()).toBe(c.eventAuthority);
    expect(hookVaultAddress(mint).toBase58()).toBe(c.vaultAddress);
    expect(vectors.accounts[0]!.address).toBe(c.vaultAddress);
    expect([0, 1, 2].map((i) => slotOwner(mint, i).toBase58())).toEqual(c.slotOwners);
    expect([0, 1, 2].map((i) => slotHolding(mint, i).toBase58())).toEqual(c.slotHoldings);
    expect(a.INCINERATOR.toBase58()).toBe(c.incinerator);
    expect([VAULT_LIMITS.maxSlots, VAULT_LIMITS.maxBountyBps, VAULT_LIMITS.maxSellBps, VAULT_LIMITS.minInterval, VAULT_LIMITS.maxInterval, VAULT_LIMITS.maxHookCutBps, VAULT_LIMITS.retireSecs]).toEqual([c.maxSlots, c.maxBountyBps, c.maxSellBps, c.minInterval, c.maxInterval, c.maxHookCutBps, c.retireSecs]);
    expect(Buffer.from(vectors.accounts[0]!.data, 'hex').length).toBe(c.vaultLen);
  });

  it('decodes a vault as the program serializes it', () => {
    expect([v.mint.toBase58(), v.hook.toBase58(), v.creator.toBase58(), v.nSlots, v.opened, v.bountyBps, v.maxSellBps, v.interval, v.maxHookCutBps]).toEqual([k.mint, k.hook, k.payer, 3, true, 50, 100, 3_600, 200]);
    expect([v.openedAt, v.createdAt, v.lastActivityAt]).toEqual([1_800_000_000, 1_799_999_000, 1_800_000_300]);
    expect([v.slots[1]!.lastAt, v.slots[1]!.waitedAt, v.slots[2]!.buyWaitedAt]).toEqual([1_800_000_200, 1_800_000_260, 1_800_000_110]);
    expect(v.slots.map((s) => s.policy)).toEqual(['burn', 'sellForSol', 'sellBuyBurn']);
    expect(v.slots.map((s) => s.target.toBase58())).toEqual([PublicKey.default.toBase58(), k.wallet, k.xPool]);
    expect(v.slots.map((s) => s.maxCutBps)).toEqual([0, 0, 300]);
    const [b, s, x] = v.slots as [typeof v.slots[0], typeof v.slots[0], typeof v.slots[0]];
    expect([b.burned, b.lastAt]).toEqual([5_000_000_000_000n, 1_800_000_100]);
    expect([s.referencePrice, s.referenceAt, s.sold, s.solOut, s.bounties]).toEqual([1_234_567_890_123n, 1_800_000_200, 9_000_000_000_000n, 250_000_000n, 1_250_000n]);
    expect([x.pendingSol, x.buyReference, x.buyReferenceAt, x.buyLastAt, x.xBurned]).toEqual([123_456_789n, 2_222_222_222n, 1_800_000_000, 1_800_000_050, 77_000_000n]);
    expect([0, 1, 2].map((i) => v.slots[i]!.ownerBump)).toEqual([0, 1, 2].map((i) => PublicKey.findProgramAddressSync([Buffer.from('slot'), mint.toBuffer(), Buffer.from([i])], a.HOOK_VAULT_PROGRAM)[1]));
    expect(() => vault.execute(cranker, { ...v, nSlots: 2 }, 2, coin, sale)).toThrow();
  });

  it('says what each slot does, a sale for SOL being a creator tax', () => {
    const words = vaultPolicyWords(v, (key) => (key.equals(wallet) ? 'the creator’s wallet' : key.equals(xPool) ? 'XX' : key.toBase58()));
    expect(words[0]).toBe('Slot 1: its cut is burned.');
    expect(words[1]).toContain('sold for SOL to the creator’s wallet');
    expect(words[1]).toContain('creator tax');
    expect(words[2]).toBe('Slot 3: its cut is sold for SOL, which buys the token of the pool XX and burns it, accepting up to 3% of each buy taken by that token’s own hook.');
    expect(words.join(' ')).toContain('at most 1% of the pool’s SOL side every 1 hour (less on a low-fee pool), split evenly: each of its 2 selling slots sells at most 0.5% of it a sale');
    expect(words).toContain('The coin’s own hook may take up to 2% of each of the vault’s sales.');
    expect(words).toContain('Whoever runs a step earns 0.5% of the SOL it moves.');
    expect(vaultIsCreatorTax(v)).toBe(true);
    expect(vaultIsCreatorTax(args)).toBe(true);
    const burnOnly: CreateVaultArgs = { ...args, slots: [{ policy: 'burn' }], maxHookCutBps: 0, interval: 60 };
    expect(vaultIsCreatorTax(burnOnly)).toBe(false);
    expect(vaultPolicyWords(burnOnly).some((w) => w.includes('hook may take'))).toBe(false);
    expect(vaultPolicyWords(burnOnly).some((w) => w.includes('sells at most'))).toBe(false);
    const oneSale: CreateVaultArgs = { ...burnOnly, slots: [{ policy: 'sellForSol', target: wallet }] };
    expect(vaultPolicyWords(oneSale).join(' ')).toContain('every 1 minute');
    expect(vaultPolicyWords(oneSale).join(' ')).not.toContain('split');
    expect(vaultPolicyWords(null)[0]).toMatch(/^No vault/);
  });

  it('opens with the mint signing only when asked (X3), from a view of the arguments as from the vault', () => {
    const plain = vault.openVault(payer, v, coin);
    const signed = vault.openVault(payer, v, coin, { mintSigns: true });
    expect(plain.keys[3]).toEqual({ pubkey: mint, isSigner: false, isWritable: false });
    expect(signed.keys[3]).toEqual({ pubkey: mint, isSigner: true, isWritable: false });
    expect(signed.keys.filter((m, i) => i !== 3)).toEqual(plain.keys.filter((m, i) => i !== 3));
    expect(vault.openVault(payer, vaultViewOf(mint, args), coin)).toEqual(plain);
  });

  it('assembles a vault coin’s launch: setup (mint signs), launch, then the creator’s open', () => {
    const launchIx = vault.createVault(payer, mint, args, [xKit.mint]); // any instruction stands in for the launch
    const seq = vaultLaunchSequence(payer, mint, args, [xKit.mint], launchIx, coin);
    expect(seq.map((x) => [x.label, x.signers])).toEqual([['setup', ['creator', 'mint']], ['launch', ['creator', 'mint']], ['open', ['creator']]]);
    expect(seq[0]!.instructions[0]).toEqual(vault.createVault(payer, mint, args, [xKit.mint]));
    expect(seq[2]!.instructions[0]).toEqual(vault.openVault(payer, v, coin));
    expect(seq[2]!.instructions[0]!.keys[0]!.pubkey).toEqual(payer);
  });

  it('explains the vault’s errors', () => {
    const names = [...PROGRAM_ERRORS.hookVault.values()].map((e) => e.name);
    expect(names).toContain('MintExists');
    expect(names).toContain('NoRoom');
    expect(names).not.toContain('SliceUsed');
    expect(PROGRAM_ERRORS.hookVault.size).toBe(27);
    const e = explainProgramError(a.HOOK_VAULT_PROGRAM, 6022);
    expect([e.program, e.name]).toEqual(['hookVault', 'MintExists']);
    const o = explainProgramError(a.HOOK_VAULT_PROGRAM, 6026);
    expect([o.name, o.explanation]).toEqual(['NotOpener', expect.stringMatching(/creator/)]);
  });
});
