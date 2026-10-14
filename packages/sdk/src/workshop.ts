/**
 * The Workshop from a terminal (docs/rules-lane.md §4): a composed config listed on the shelves as
 * the wallet that made it, through Bordrless's API (`BORDRLESS_API`, the site's own path to it).
 *
 * The API acts as a wallet signed in once with a plain message (`studioSignInMessage`: no
 * transaction, nothing moves), the session the Workshop's pages use: `workshop.signIn` asks the
 * wallet to sign it and answers the session token (a week long); `workshop.registerComposed` lists
 * a composed config with it (`POST /v1/workshop/register`: the config must be on chain, the rules
 * engine's, its set bound, listed with a creator fee and made by this wallet; six a day; no fee).
 * The item is `kind: 'hook'`, `lane: 'rules'`, approved at once, its words read from its rules.
 *
 * The rules lane is off the site (the owner, 2026-10-13: "Compose a hook" is shown nowhere on
 * bordrless.app): these calls stay for the deployed engine, but a builder's hook goes through the
 * Workshop's code lane (the README's "Hooks, companions and pairs from your own terminal").
 */
import { randomBytes } from 'node:crypto';
import anchor from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { STUDIO_SESSION_HEADER, studioSignInMessage, type StudioSessionResponse, type WorkshopDetail } from '@bordrless/shared';

const bs58 = anchor.utils.bytes.bs58;

/** Bordrless's API, as the site serves it (the site's proxy passes a signed-in wallet's session on). */
export const BORDRLESS_API = 'https://bordrless.app/api';

export interface WorkshopApiOptions {
  /** The API's base URL, `BORDRLESS_API` unless given (a local server's for a test). */
  api?: string;
  /** The `fetch` to call it with; the global one unless given. */
  fetch?: typeof fetch;
}

/** What the API answered instead: its status, its code (`config_listed`, `not_composed`, `rules_closed`, ...) and its sentence. */
export class WorkshopApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'WorkshopApiError';
    this.status = status;
    this.code = code;
  }
}

/** A wallet's signature of a message: a Keypair's (`nacl.sign.detached`), or a wallet adapter's `signMessage`. */
export type MessageSigner = (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;

async function post<T>(path: string, body: unknown, opts: WorkshopApiOptions, session: string | null = null): Promise<T> {
  const call = opts.fetch ?? globalThis.fetch;
  const res = await call(`${(opts.api ?? BORDRLESS_API).replace(/\/+$/, '')}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { [STUDIO_SESSION_HEADER]: session } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (typeof json === 'object' && json !== null ? json : {}) as { error?: unknown; code?: unknown };
    throw new WorkshopApiError(res.status, typeof e.code === 'string' ? e.code : null, typeof e.error === 'string' ? e.error : `The API answered ${res.status}.`);
  }
  return json as T;
}

const keyOf = (key: PublicKey | string): string => (typeof key === 'string' ? new PublicKey(key) : key).toBase58();

export const workshop = {
  /** The message `signIn` has the wallet sign: the Workshop's own (`studioSignInMessage`), with a fresh nonce and the time now. */
  signInMessage(wallet: PublicKey | string, nonce: string = randomBytes(16).toString('base64url'), issuedAt: string = new Date().toISOString()): string {
    return studioSignInMessage(keyOf(wallet), nonce, issuedAt);
  },

  /**
   * Signs in as `wallet` (`POST /v1/studio/session`): `sign` signs the Workshop's sign-in message, a
   * plain message, never a transaction. The answer's `token` is the session `registerComposed` takes;
   * it lasts a week.
   */
  async signIn(wallet: PublicKey | string, sign: MessageSigner, opts: WorkshopApiOptions = {}): Promise<StudioSessionResponse> {
    const address = keyOf(wallet);
    const message = workshop.signInMessage(address);
    const signature = await sign(new TextEncoder().encode(message));
    return post<StudioSessionResponse>('studio/session', { wallet: address, message, signature: bs58.encode(signature) }, opts);
  },

  /**
   * Lists a composed config on the Workshop's shelves (`POST /v1/workshop/register`), as the wallet
   * `session` stands for (`signIn`): the config `buildCreateComposedConfig` made with `listed: true`,
   * once its transaction landed. `name` is the item's name (the config's label unless given). Answers
   * the item (`lane: 'rules'`, `config`, the engine as its `program`, its words); throws
   * `WorkshopApiError` with the API's code when it is refused (`config_listed`, `not_listed`,
   * `rules_unbound`, `workshop_daily`, `rules_closed` while the engine is not deployed, ...).
   */
  async registerComposed(config: PublicKey | string, session: string | Pick<StudioSessionResponse, 'token'>, opts: WorkshopApiOptions & { name?: string } = {}): Promise<WorkshopDetail> {
    const token = typeof session === 'string' ? session : session.token;
    if (!token) throw new WorkshopApiError(401, 'studio_signin', 'Sign in with your wallet first (workshop.signIn).');
    return post<WorkshopDetail>('workshop/register', { config: keyOf(config), ...(opts.name?.trim() ? { name: opts.name.trim() } : {}) }, opts, token);
  },
};
