/** Payees and wallet payouts (2026-10-13) against the companion's IDL: the builders' accounts and the encodings. */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { companion } from './companion.ts';
import { LOSS_COVER_DISCRIMINATORS, PAYOUT_TERMS_LEN, WALLET_PAYOUT_ANSWER_VERSION, decodePayoutTerms, decodeScriptAnswer, decodeWalletPayoutAnswer, encodePayoutAnswer, encodePayoutTerms, encodeWalletPayoutAnswer } from './lossCover.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const metas = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) => ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);

describe('payees', () => {
  it('set_payees: the payer and the mint sign, the payees account is the mint’s', () => {
    const payer = k();
    const mint = k();
    const p = [{ wallet: k(), bps: 3_000 }, { wallet: k(), bps: 2_000 }];
    const ix = companion.setPayees(payer, mint, p);
    expect(metas(ix).slice(0, 5)).toEqual([
      [payer.toBase58(), true, true],
      [mint.toBase58(), true, false],
      [a.companionAddress(mint).toBase58(), false, true],
      [a.payeesAddress(mint).toBase58(), false, true],
      [a.SYSTEM_PROGRAM.toBase58(), false, false],
    ]);
    const d = CODERS.companion.instruction.decode(ix.data) as { name: string; data: { entries: { wallet: PublicKey; bps: number }[] } };
    expect(d.name).toBe('setPayees');
    expect(d.data.entries.map((e) => [e.wallet.toBase58(), e.bps])).toEqual(p.map((e) => [e.wallet.toBase58(), e.bps]));
  });

  it('withdrawWithPayees: withdraw, then the payees account and each payee, writable', () => {
    const mint = k();
    const beneficiary = k();
    const p = [k(), k()];
    const plain = companion.withdraw(k(), mint, beneficiary);
    const ix = companion.withdrawWithPayees(k(), mint, beneficiary, p);
    expect(ix.keys.length).toBe(plain.keys.length + 3);
    expect(metas(ix).slice(-3)).toEqual([[a.payeesAddress(mint).toBase58(), false, true], ...p.map((x) => [x.toBase58(), false, true])]);
  });

  it('allowWalletPayouts: the mint signs, the terms are written', () => {
    const mint = k();
    const ix = companion.allowWalletPayouts(mint);
    expect(metas(ix).slice(0, 4)).toEqual([
      [mint.toBase58(), true, false],
      [a.companionAddress(mint).toBase58(), false, false],
      [a.payoutTermsAddress(mint).toBase58(), false, true],
      [a.scriptAddress(mint).toBase58(), false, false],
    ]);
    expect((CODERS.companion.instruction.decode(ix.data) as { name: string }).name).toBe('allowWalletPayouts');
  });

  it('a wallet answer is 1 + 4 + 44 * n bytes: the version, the count, each key, lamports and tag', () => {
    const to = k();
    const b = encodeWalletPayoutAnswer([{ to, lamports: 5n, tag: 7 }]);
    expect(b.length).toBe(49);
    expect(b[0]).toBe(WALLET_PAYOUT_ANSWER_VERSION);
    expect(b.readUInt32LE(1)).toBe(1);
    expect(new PublicKey(b.subarray(5, 37)).equals(to)).toBe(true);
    expect(b.readBigUInt64LE(37)).toBe(5n);
    expect(b.readUInt32LE(45)).toBe(7);
    expect(encodeWalletPayoutAnswer(Array.from({ length: 16 }, () => ({ to, lamports: 1n, tag: 0 }))).length).toBe(5 + 44 * 16);
    expect(() => encodeWalletPayoutAnswer(Array.from({ length: 17 }, () => ({ to, lamports: 1n, tag: 0 })))).toThrow();
  });

  it('a wallet answer reads back exactly, and a script’s answer is read by its version byte', () => {
    const entries = [{ to: k(), lamports: 5n, tag: 7 }, { to: k(), lamports: 1_000_000n, tag: 0 }];
    const b = encodeWalletPayoutAnswer(entries);
    const back = decodeWalletPayoutAnswer(b);
    expect(back.version).toBe(WALLET_PAYOUT_ANSWER_VERSION);
    expect(back.entries.map((e) => [e.to.toBase58(), e.lamports, e.tag])).toEqual(entries.map((e) => [e.to.toBase58(), e.lamports, e.tag]));
    expect(decodeScriptAnswer(b)).toEqual(back);
    const holdings = { version: 1, entries: [{ account: 3, lamports: 9n, tag: 1 }] };
    expect(decodeScriptAnswer(encodePayoutAnswer(holdings))).toEqual(holdings);
    // Not a byte short or over; a holdings answer is not a wallet answer.
    expect(() => decodeWalletPayoutAnswer(b.subarray(0, b.length - 1))).toThrow(/BadPayoutAnswer/);
    expect(() => decodeWalletPayoutAnswer(Buffer.concat([b, Buffer.from([0])]))).toThrow(/BadPayoutAnswer/);
    expect(() => decodeWalletPayoutAnswer(encodePayoutAnswer(holdings))).toThrow(/BadPayoutAnswer/);
    expect(() => decodeScriptAnswer(Buffer.from([2, 1, 0, 0]))).toThrow(/BadPayoutAnswer/);
  });

  it('the payout terms say whether the launcher allowed wallet payouts: reserved[0], byte 100', () => {
    const data = Buffer.alloc(PAYOUT_TERMS_LEN);
    LOSS_COVER_DISCRIMINATORS.payoutTerms.copy(data, 0);
    data[8] = 1;
    data.writeUInt32LE(300, 48);
    expect(decodePayoutTerms(data).walletsAllowed).toBe(false);
    data[100] = 1;
    const allowed = decodePayoutTerms(data);
    expect(allowed.walletsAllowed).toBe(true);
    expect(encodePayoutTerms(allowed).equals(data)).toBe(true);
    expect(encodePayoutTerms({ ...allowed, walletsAllowed: false })[100]).toBe(0);
  });
});
