/**
 * The Workshop hook template's standard instruction (`tools/studio-builder/template/src/lib.rs`;
 * `STUDIO_PREPARE` in @bordrless/shared): every hook written on the template has `prepare`, with the
 * same accounts, and the template's static checks hold a submission to it. It creates the hook's
 * state for a mint at `PDA(["state", mint], hook)` and writes the hook's registry at
 * `PDA(["bordrless-hook-accounts", mint], hook)`, so a launch can name the hook for a mint that does
 * not exist yet. Anyone may send it, once per mint, the payer paying the rent.
 *
 * A Workshop hook is prepared by the launch itself (the site dry-runs this instruction and reads the
 * registry it writes). A hook you deployed yourself (the self-serve lane: immutable, a config of
 * yours) is yours to prepare, before the launch, for the mint address the launch page shows:
 * `templateHook.prepare(hook, me, mint)`, then `inspectTokenHook(connection, hook, mint)` (or
 * `fetchCustomHookAccounts`) to resolve what the registry lists. A game hook written on the same
 * template (`studioGameHook`) keeps its state at the same address.
 */
import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { STUDIO_PREPARE } from '@bordrless/shared';
import { SYSTEM_PROGRAM, registryAddress } from './addresses.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });

/** `sha256("global:prepare")[..8]`: what Anchor gives the template's `prepare`. */
export const PREPARE_DISCRIMINATOR: Buffer = createHash('sha256').update(`global:${STUDIO_PREPARE.instruction}`).digest().subarray(0, 8);

/** A template hook's state for a mint: `PDA(["state", mint])` under the hook (the standard `prepare` creates it). */
export const hookStateAddress = (hook: PublicKey, mint: PublicKey): PublicKey => PublicKey.findProgramAddressSync([Buffer.from(STUDIO_PREPARE.stateSeed, 'utf8'), mint.toBuffer()], hook)[0];

export const templateHook = {
  /**
   * The standard `prepare` of the hook `hook` for `mint` (which need not exist yet): 5 accounts,
   * `payer` (signer, writable), `mint`, the state (writable), the registry (writable), the system
   * program; no arguments. The same instruction the launch sends for a Workshop hook.
   */
  prepare(hook: PublicKey, payer: PublicKey, mint: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: hook,
      keys: [rw(payer, true), ro(mint), rw(hookStateAddress(hook, mint)), rw(registryAddress(hook, mint)), ro(SYSTEM_PROGRAM)],
      data: Buffer.from(PREPARE_DISCRIMINATOR),
    });
  },
};
