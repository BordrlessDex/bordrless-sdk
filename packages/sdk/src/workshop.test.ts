/**
 * The Workshop from a terminal (workshop.ts, docs/rules-lane.md §4): the sign-in message is the
 * Workshop's own, signed by the wallet and checked as the API checks it; a composed config is listed
 * with the session, and the API's refusals come back by code.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify } from 'node:crypto';
import anchor from '@anchor-lang/core';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { STUDIO_SESSION_HEADER, studioSignInMessage } from '@bordrless/shared';
import { BORDRLESS_API, WorkshopApiError, workshop } from './workshop.ts';

const bs58 = anchor.utils.bytes.bs58;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** A Keypair signing a message, as a wallet's `signMessage` does. */
const signer = (kp: Keypair) => (message: Uint8Array): Uint8Array => new Uint8Array(cryptoSign(null, message, createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, kp.secretKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' })));
/** The API's own check (apps/server/src/studio/session.ts `signedBy`). */
const signedBy = (wallet: Keypair, message: string, signature: string): boolean => verify(null, Buffer.from(message, 'utf8'), createPublicKey({ key: Buffer.concat([SPKI_ED25519, wallet.publicKey.toBuffer()]), format: 'der', type: 'spki' }), Buffer.from(bs58.decode(signature)));

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records what it was sent and answers `answer`. */
function fakeFetch(answer: (sent: Sent) => { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const s = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
    sent.push(s);
    const a = answer(s);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe('workshop.signIn', () => {
  it('signs the Workshop’s sign-in message with the wallet, a message and never a transaction, and answers the session', async () => {
    const wallet = Keypair.generate();
    const api = fakeFetch((s) => ({ status: 200, body: { token: 'session-token', wallet: s.body.wallet, expiresAt: 1_900_000_000, quota: { messagesLeft: 10, messagesPerDay: 10, assistantOff: false } } }));
    const session = await workshop.signIn(wallet.publicKey, signer(wallet), { fetch: api.fetch });
    expect(session.token).toBe('session-token');
    const [s] = api.sent;
    expect(s!.url).toBe(`${BORDRLESS_API}/studio/session`);
    expect(s!.method).toBe('POST');
    const message = s!.body.message as string;
    const nonce = /^Nonce: (.+)$/m.exec(message)![1]!;
    const issued = /^Issued: (.+)$/m.exec(message)![1]!;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(message).toBe(studioSignInMessage(wallet.publicKey.toBase58(), nonce, issued));
    expect(signedBy(wallet, message, s!.body.signature as string)).toBe(true);
    expect(s!.headers[STUDIO_SESSION_HEADER]).toBeUndefined();
  });
});

describe('workshop.registerComposed', () => {
  const CONFIG = Keypair.generate().publicKey;

  it('lists a composed config as the signed-in wallet and answers the item', async () => {
    const item = { id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', kind: 'hook', lane: 'rules', config: CONFIG.toBase58(), status: 'approved' };
    const api = fakeFetch(() => ({ status: 200, body: item }));
    const got = await workshop.registerComposed(CONFIG, { token: 'session-token' }, { fetch: api.fetch, api: 'http://127.0.0.1:8080/v1/', name: '  Loss shield ' });
    expect(got).toEqual(item);
    expect(api.sent).toEqual([{ url: 'http://127.0.0.1:8080/v1/workshop/register', method: 'POST', headers: { 'content-type': 'application/json', [STUDIO_SESSION_HEADER]: 'session-token' }, body: { config: CONFIG.toBase58(), name: 'Loss shield' } }]);
    // A key as text is taken too; no name sends none.
    await workshop.registerComposed(CONFIG.toBase58(), 'session-token', { fetch: api.fetch });
    expect(api.sent[1]!.body).toEqual({ config: CONFIG.toBase58() });
    expect(api.sent[1]!.url).toBe(`${BORDRLESS_API}/workshop/register`);
  });

  it('throws the API’s refusal with its status and code, and asks for a session first', async () => {
    const api = fakeFetch(() => ({ status: 409, body: { error: 'That config is listed already.', code: 'config_listed' } }));
    const err = await workshop.registerComposed(CONFIG, 'session-token', { fetch: api.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkshopApiError);
    expect(err).toMatchObject({ status: 409, code: 'config_listed', message: 'That config is listed already.' });
    const closed = fakeFetch(() => ({ status: 503, body: { error: 'The rules engine is not deployed on this cluster yet: a composed hook cannot be made.', code: 'rules_closed' } }));
    await expect(workshop.registerComposed(CONFIG, 'session-token', { fetch: closed.fetch })).rejects.toMatchObject({ status: 503, code: 'rules_closed' });
    await expect(workshop.registerComposed(CONFIG, '', { fetch: api.fetch })).rejects.toMatchObject({ status: 401, code: 'studio_signin' });
    expect(() => workshop.signInMessage('not a key')).toThrow();
  });
});
