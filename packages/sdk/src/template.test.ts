/**
 * The hook template's standard `prepare`, as the Workshop's checks hold every hook to it and as the
 * site sends it for a Workshop hook (apps/server/src/studio/prepare.ts): Anchor's discriminator for
 * `prepare`, the five accounts in order, and the state at `["state", mint]` under the hook.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { STUDIO_PREPARE } from '@bordrless/shared';
import { SYSTEM_PROGRAM, gameStateAddress, registryAddress } from './addresses.ts';
import { studioGameHook } from './gameKinds.ts';
import { PREPARE_DISCRIMINATOR, hookStateAddress, templateHook } from './template.ts';

const k = (): PublicKey => Keypair.generate().publicKey;

describe('the template hook’s prepare', () => {
  it('is Anchor’s `prepare` with no arguments', () => {
    expect(STUDIO_PREPARE.instruction).toBe('prepare');
    expect(PREPARE_DISCRIMINATOR.toString('hex')).toBe(createHash('sha256').update('global:prepare').digest().subarray(0, 8).toString('hex'));
    const ix = templateHook.prepare(k(), k(), k());
    expect(ix.data.toString('hex')).toBe(PREPARE_DISCRIMINATOR.toString('hex'));
  });

  it('takes the payer, the mint, the state, the registry and the system program, in that order', () => {
    const [hook, payer, mint] = [k(), k(), k()];
    const ix = templateHook.prepare(hook, payer, mint);
    expect(ix.programId.equals(hook)).toBe(true);
    expect(ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual([
      [payer.toBase58(), true, true],
      [mint.toBase58(), false, false],
      [hookStateAddress(hook, mint).toBase58(), false, true],
      [registryAddress(hook, mint).toBase58(), false, true],
      [SYSTEM_PROGRAM.toBase58(), false, false],
    ]);
  });

  it('keeps the state at ["state", mint] under the hook: a game hook’s state, and the same instruction a game starter takes', () => {
    const [hook, payer, mint] = [k(), k(), k()];
    expect(hookStateAddress(hook, mint).equals(PublicKey.findProgramAddressSync([Buffer.from(STUDIO_PREPARE.stateSeed), mint.toBuffer()], hook)[0])).toBe(true);
    expect(hookStateAddress(hook, mint).equals(gameStateAddress(hook, mint))).toBe(true);
    const game = studioGameHook.prepare(hook, payer, mint);
    const plain = templateHook.prepare(hook, payer, mint);
    expect(game.data.equals(plain.data)).toBe(true);
    expect(game.keys).toEqual(plain.keys);
  });
});
