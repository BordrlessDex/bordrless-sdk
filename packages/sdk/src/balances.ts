/**
 * A transaction's Bordrless holdings, before and after, in the shape of Solana's token balances.
 *
 * The RPC's `preTokenBalances` and `postTokenBalances` cover SPL and Token-2022 accounts only; a
 * Bordrless holding is an account of the token program, so the meta says nothing about it. The
 * token program emits an event for every balance change instead (`Transferred`, `Minted`,
 * `Burned`, each with the post-balances of the holdings it touched), as a self-CPI in the inner
 * instructions. This module reads those events back into web3.js's `TokenBalance` shape, so a
 * terminal's SPL code runs on them unchanged:
 *
 *   source pre      = source_post + amount
 *   destination pre = destination_post − (amount − Σ deltas)      the hooks' cuts never reach it
 *   delta pre       = delta.post − delta.amount                    each cut holding gained its amount
 *   minted pre      = destination_post − amount;  burned pre = source_post + amount
 *
 * Several events on one holding chain in order: the first gives its pre, the last its post. A
 * holding created in the transaction (`HoldingCreated`) has no pre entry, like a token account
 * created in one; a holding closed in it (`HoldingClosed`) has no post entry.
 *
 * Decimals are per mint and not in the transfer events: a `MintCreated` in the same transaction
 * carries them; otherwise they are read from the mint account (`decodeMint`). Nothing here guesses:
 * a mint whose decimals cannot be read is a `MissingDecimalsError`. Launch tokens are 6, bridged SOL
 * and LP mints 9, a free mint whatever its creator chose (0 to 12).
 *
 * Not derivable from events: nothing about balances. The one thing the events do not carry is the
 * holding's `accountIndex`, which comes from the transaction's account keys (−1 when the caller
 * gave none). A failed transaction changed nothing and gives empty arrays.
 */
import anchor from '@anchor-lang/core';
import { PublicKey, type Connection } from '@solana/web3.js';
import { decodeMint } from './accounts.ts';
import { TOKEN_PROGRAM } from './addresses.ts';
import { eventKey, eventsOf, type DecodedEvent, type RawInnerInstruction } from './events.ts';

const bs58 = anchor.utils.bytes.bs58;
const TOKEN_PROGRAM_ID = TOKEN_PROGRAM.toBase58();

// ---- shapes ----------------------------------------------------------------------------------------

/** A balance as Solana's `TokenAmount` gives it: raw units, the mint's decimals, the float (null at 0, as the RPC does) and the exact string. */
export interface HoldingTokenAmount {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}

/**
 * One side of a holding's balance, assignable to web3.js's `TokenBalance`, plus `account`: the
 * holding's address, which SPL code reads as `accountKeys[accountIndex]`. `accountIndex` is −1
 * when the holding is not among the account keys the caller gave.
 */
export interface HoldingTokenBalance {
  accountIndex: number;
  account: string;
  mint: string;
  owner: string;
  programId: string;
  uiTokenAmount: HoldingTokenAmount;
}

/** One holding the transaction touched: its balance before and after, raw and as decimal strings. */
export interface HoldingBalanceChange {
  accountIndex: number;
  account: string;
  mint: string;
  owner: string;
  programId: string;
  decimals: number;
  /** Raw units before the transaction; "0" for a holding created in it. */
  pre: string;
  /** Raw units after; "0" for a holding closed in it. */
  post: string;
  uiPreAmountString: string;
  uiPostAmountString: string;
  /** `post − pre`, raw units, signed. */
  change: string;
  /** The holding was created in this transaction: it has no `preTokenBalances` entry. */
  created: boolean;
  /** The holding was closed in this transaction: it has no `postTokenBalances` entry. */
  closed: boolean;
}

export interface HoldingBalanceChanges {
  /** One row per holding touched, in account-index order (holdings without an index last, in event order). */
  changes: HoldingBalanceChange[];
  /** Solana's shape: every holding that existed before the transaction. */
  preTokenBalances: HoldingTokenBalance[];
  /** Solana's shape: every holding that exists after it. */
  postTokenBalances: HoldingTokenBalance[];
  /** The decimals used, by mint. */
  decimalsBy: Record<string, number>;
}

/** Decimals a caller could not provide for mints the transaction touched. Never guessed: read `decodeMint`. */
export class MissingDecimalsError extends Error {
  readonly mints: readonly string[];
  constructor(mints: readonly string[]) {
    super(`decimals unknown for mint${mints.length === 1 ? '' : 's'} ${mints.join(', ')}: pass decimalsOf or a connection (decimals are per mint; read the mint account, never assume 6)`);
    this.name = 'MissingDecimalsError';
    this.mints = mints;
  }
}

// ---- amounts ---------------------------------------------------------------------------------------

/** `amount` in `decimals` as the RPC's `uiAmountString` writes it: exact, trailing zeros trimmed, "0" for zero. */
export function uiAmountString(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function tokenAmount(amount: bigint, decimals: number): HoldingTokenAmount {
  const s = uiAmountString(amount, decimals);
  return { amount: amount.toString(), decimals, uiAmount: amount === 0n ? null : Number(s), uiAmountString: s };
}

// ---- the pure core: events in, changes out ----------------------------------------------------------

const str = (v: unknown): string => String(v);
const big = (v: unknown): bigint => BigInt(String(v));

interface Touched {
  mint: string;
  owner: string;
  pre: bigint;
  post: bigint;
  created: boolean;
  closed: boolean;
}

/** The mints whose holdings the token events touch (decimals are needed for each). */
export function touchedMints(events: readonly DecodedEvent[]): string[] {
  const out = new Set<string>();
  for (const ev of events) {
    if (ev.program !== 'token') continue;
    switch (eventKey(ev)) {
      case 'token.Transferred':
      case 'token.Minted':
      case 'token.Burned':
      case 'token.HoldingCreated':
      case 'token.HoldingClosed':
        out.add(str(ev.data.mint));
        break;
      default:
        break;
    }
  }
  return [...out];
}

/** The decimals `MintCreated` events in the list state, by mint. */
export function createdMintDecimals(events: readonly DecodedEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ev of events) if (ev.program === 'token' && eventKey(ev) === 'token.MintCreated') out[str(ev.data.mint)] = Number(ev.data.decimals);
  return out;
}

/**
 * The balance changes the token program's events describe, with no RPC: `events` as `eventsOf`
 * gives them (the token program's, in order; other programs' are ignored), `decimalsBy` the decimals
 * of every mint touched (a `MintCreated` in the list supplies its own), `accountKeys` the
 * transaction's keys for the account indices. Throws `MissingDecimalsError` for a mint without decimals.
 */
export function holdingBalanceChanges(events: readonly DecodedEvent[], decimalsBy: Readonly<Record<string, number>> = {}, accountKeys: readonly string[] = []): HoldingBalanceChanges {
  const decimals: Record<string, number> = { ...createdMintDecimals(events), ...decimalsBy };
  const missing = touchedMints(events).filter((m) => typeof decimals[m] !== 'number');
  if (missing.length > 0) throw new MissingDecimalsError(missing);

  const touched = new Map<string, Touched>();
  const leg = (holding: string, mint: string, owner: string, delta: bigint, post: bigint): void => {
    const t = touched.get(holding);
    if (!t) touched.set(holding, { mint, owner, pre: post - delta, post, created: false, closed: false });
    else {
      t.post = post;
      t.owner = owner;
      t.closed = false;
    }
  };
  for (const ev of events) {
    if (ev.program !== 'token') continue;
    const d = ev.data;
    switch (eventKey(ev)) {
      case 'token.Transferred': {
        const mint = str(d.mint);
        const amount = big(d.amount);
        const deltas = Array.isArray(d.deltas) ? (d.deltas as Record<string, unknown>[]) : [];
        const taken = deltas.reduce((sum, x) => sum + big(x.amount), 0n);
        leg(str(d.source), mint, str(d.sourceOwner), -amount, big(d.sourcePost));
        leg(str(d.destination), mint, str(d.destinationOwner), amount - taken, big(d.destinationPost));
        for (const x of deltas) leg(str(x.holding), mint, str(x.owner), big(x.amount), big(x.post));
        break;
      }
      case 'token.Minted':
        leg(str(d.destination), str(d.mint), str(d.destinationOwner), big(d.amount), big(d.destinationPost));
        break;
      case 'token.Burned':
        leg(str(d.source), str(d.mint), str(d.sourceOwner), -big(d.amount), big(d.sourcePost));
        break;
      case 'token.HoldingCreated': {
        const holding = str(d.holding);
        if (!touched.has(holding)) touched.set(holding, { mint: str(d.mint), owner: str(d.owner), pre: 0n, post: 0n, created: true, closed: false });
        break;
      }
      case 'token.HoldingClosed': {
        const holding = str(d.holding);
        const t = touched.get(holding);
        if (t) {
          t.closed = true;
          t.post = 0n;
        } else touched.set(holding, { mint: str(d.mint), owner: str(d.owner), pre: 0n, post: 0n, created: false, closed: true });
        break;
      }
      default:
        break;
    }
  }

  const rows: HoldingBalanceChange[] = [];
  for (const [account, t] of touched) {
    // Created and closed in one transaction: it neither existed before nor exists after.
    if (t.created && t.closed) continue;
    const dec = decimals[t.mint]!;
    rows.push({
      accountIndex: accountKeys.indexOf(account),
      account,
      mint: t.mint,
      owner: t.owner,
      programId: TOKEN_PROGRAM_ID,
      decimals: dec,
      pre: t.pre.toString(),
      post: t.post.toString(),
      uiPreAmountString: uiAmountString(t.pre, dec),
      uiPostAmountString: uiAmountString(t.post, dec),
      change: (t.post - t.pre).toString(),
      created: t.created,
      closed: t.closed,
    });
  }
  rows.sort((a, b) => (a.accountIndex < 0 ? Number.MAX_SAFE_INTEGER : a.accountIndex) - (b.accountIndex < 0 ? Number.MAX_SAFE_INTEGER : b.accountIndex));
  const side = (r: HoldingBalanceChange, amount: string): HoldingTokenBalance => ({ accountIndex: r.accountIndex, account: r.account, mint: r.mint, owner: r.owner, programId: r.programId, uiTokenAmount: tokenAmount(BigInt(amount), r.decimals) });
  const used: Record<string, number> = {};
  for (const r of rows) used[r.mint] = r.decimals;
  return {
    changes: rows,
    preTokenBalances: rows.filter((r) => !r.created).map((r) => side(r, r.pre)),
    postTokenBalances: rows.filter((r) => !r.closed).map((r) => side(r, r.post)),
    decimalsBy: used,
  };
}

// ---- any transaction shape -------------------------------------------------------------------------

type KeyLike = string | PublicKey | { pubkey: PublicKey | string };
type InnerLike = { programIdIndex: number; accounts: readonly number[]; data: string } | { programId: PublicKey | string; accounts: readonly (PublicKey | string)[]; data: string } | { programId: PublicKey | string; parsed: unknown };

/**
 * A transaction as any of the RPC's encodings gives it: web3.js's `VersionedTransactionResponse`
 * (`getTransaction`), `ParsedTransactionWithMeta` (`getParsedTransaction`), or the raw JSON reply.
 */
export interface TransactionLike {
  slot?: number;
  blockTime?: number | null;
  transaction: { message: { accountKeys?: readonly KeyLike[]; staticAccountKeys?: readonly PublicKey[] } };
  meta: {
    err?: unknown;
    innerInstructions?: readonly { index: number; instructions: readonly InnerLike[] }[] | null;
    loadedAddresses?: { writable: readonly (string | PublicKey)[]; readonly: readonly (string | PublicKey)[] } | null;
  } | null;
}

const keyOf = (k: KeyLike): string => (typeof k === 'string' ? k : k instanceof PublicKey ? k.toBase58() : String(k.pubkey));

/** Every account key in index order (static, then the lookup table's writable, then readonly), as `eventsOf` wants them. */
export function transactionAccountKeys(tx: TransactionLike): string[] {
  const message = tx.transaction.message;
  const base = (message.staticAccountKeys ?? message.accountKeys ?? []).map(keyOf);
  const keys = [...base];
  for (const k of [...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])].map(keyOf)) if (!keys.includes(k)) keys.push(k);
  return keys;
}

/** Every inner instruction in execution order, indices resolved against `keys` for the parsed encoding. */
export function transactionInnerInstructions(tx: TransactionLike, keys: readonly string[]): RawInnerInstruction[] {
  const groups = [...(tx.meta?.innerInstructions ?? [])].sort((a, b) => a.index - b.index);
  const out: RawInnerInstruction[] = [];
  for (const g of groups) {
    for (const ix of g.instructions) {
      if ('programIdIndex' in ix) out.push({ programIdIndex: ix.programIdIndex, accounts: [...ix.accounts], data: ix.data });
      else if ('data' in ix) out.push({ programIdIndex: keys.indexOf(keyOf(ix.programId)), accounts: ix.accounts.map((a) => keys.indexOf(keyOf(a))), data: ix.data });
      // A `parsed` instruction is a known program's (system, SPL…): never one of the token program's events.
    }
  }
  return out;
}

/** The token program's events of a transaction, with its account keys; empty when the transaction failed (nothing changed). */
export function transactionTokenEvents(tx: TransactionLike): { accountKeys: string[]; events: DecodedEvent[] } {
  if (!tx.meta) throw new Error('the transaction has no meta: fetch it with getTransaction (its inner instructions carry the events)');
  const accountKeys = transactionAccountKeys(tx);
  if (tx.meta.err) return { accountKeys, events: [] };
  if (tx.meta.innerInstructions === null || tx.meta.innerInstructions === undefined) throw new Error('the transaction meta has no innerInstructions: the node did not record them, and the token events live there');
  return { accountKeys, events: eventsOf(accountKeys, transactionInnerInstructions(tx, accountKeys), (data) => bs58.decode(data), ['token']) };
}

// ---- decimals --------------------------------------------------------------------------------------

export interface TokenBalanceChangesOptions {
  /** The decimals of a mint, when no `MintCreated` in the transaction gives them. */
  decimalsOf?: (mint: string) => Promise<number> | number;
  /** Without `decimalsOf`: the connection to read the mint accounts over (`mintDecimalsReader`). */
  connection?: Pick<Connection, 'getAccountInfo'>;
}

/**
 * Reads a mint's decimals from its account with `decodeMint`, once per mint for the reader's life
 * (decimals never change). Throws for an address that is not a mint of the token program.
 */
export function mintDecimalsReader(connection: Pick<Connection, 'getAccountInfo'>): (mint: string) => Promise<number> {
  const cache = new Map<string, Promise<number>>();
  return (mint: string): Promise<number> => {
    let p = cache.get(mint);
    if (!p) {
      p = connection.getAccountInfo(new PublicKey(mint), 'confirmed').then((info) => {
        if (!info || !info.owner.equals(TOKEN_PROGRAM)) throw new MissingDecimalsError([mint]);
        return decodeMint(info.data).decimals;
      });
      p.catch(() => cache.delete(mint));
      cache.set(mint, p);
    }
    return p;
  };
}

/**
 * The balance changes of every Bordrless holding a transaction touched, as `preTokenBalances` and
 * `postTokenBalances` in Solana's shape plus one row per holding. `tx` is any of the RPC's
 * encodings; decimals come from a `MintCreated` in the transaction, else `opts.decimalsOf`, else the
 * mint accounts read over `opts.connection`; with neither, a `MissingDecimalsError` names the mints.
 */
export async function tokenBalanceChanges(tx: TransactionLike, opts: TokenBalanceChangesOptions = {}): Promise<HoldingBalanceChanges> {
  const { accountKeys, events } = transactionTokenEvents(tx);
  const decimals = createdMintDecimals(events);
  const missing = touchedMints(events).filter((m) => typeof decimals[m] !== 'number');
  if (missing.length > 0) {
    const read = opts.decimalsOf ?? (opts.connection ? mintDecimalsReader(opts.connection) : null);
    if (!read) throw new MissingDecimalsError(missing);
    const found = await Promise.all(missing.map((m) => read(m)));
    missing.forEach((m, i) => {
      const n = found[i];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 12) throw new MissingDecimalsError([m]);
      decimals[m] = n;
    });
  }
  return holdingBalanceChanges(events, decimals, accountKeys);
}
