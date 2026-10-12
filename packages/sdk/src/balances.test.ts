/**
 * Balance changes from the token program's events: pre from post and the event's amounts, hook
 * deltas kept from the destination, several events on one holding chained in order, holdings created
 * or closed in the transaction, decimals from `MintCreated` or the caller and never guessed, and the
 * three transaction encodings read alike.
 */
import { describe, expect, it } from 'vitest';
import anchor from '@anchor-lang/core';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, type ParsedTransactionWithMeta, type TokenBalance, type VersionedTransactionResponse } from '@solana/web3.js';
import * as a from './addresses.ts';
import { MissingDecimalsError, holdingBalanceChanges, tokenBalanceChanges, uiAmountString, type HoldingTokenBalance, type TransactionLike } from './balances.ts';
import { CODERS, IDL } from './coders.ts';
import { EVENT_IX_TAG, type DecodedEvent } from './events.ts';

const bs58 = anchor.utils.bytes.bs58;
const TOKEN = a.TOKEN_PROGRAM.toBase58();
const k = (): string => Keypair.generate().publicKey.toBase58();
const bn = (v: bigint | number): BN => new BN(v.toString());

/** A decoded event as `eventsOf` gives it (keys base58, integers decimal strings). */
const ev = (name: string, data: Record<string, unknown>): DecodedEvent => ({ ordinal: 0, program: 'token', programId: TOKEN, name, data });
interface Transfer {
  mint: string;
  source: string;
  destination: string;
  sourceOwner: string;
  destinationOwner: string;
  amount: bigint;
  sourcePost: bigint;
  destinationPost: bigint;
  deltas?: { holding: string; owner: string; amount: bigint; post: bigint }[];
}
const transferred = (t: Transfer): DecodedEvent =>
  ev('transferred', {
    mint: t.mint,
    source: t.source,
    destination: t.destination,
    sourceOwner: t.sourceOwner,
    destinationOwner: t.destinationOwner,
    authority: t.sourceOwner,
    amount: t.amount.toString(),
    deltas: (t.deltas ?? []).map((d) => ({ holding: d.holding, owner: d.owner, amount: d.amount.toString(), post: d.post.toString() })),
    sourcePost: t.sourcePost.toString(),
    destinationPost: t.destinationPost.toString(),
    slot: '1',
    ts: '1',
  });
const minted = (mint: string, destination: string, owner: string, amount: bigint, post: bigint): DecodedEvent => ev('minted', { mint, destination, destinationOwner: owner, authority: owner, amount: amount.toString(), destinationPost: post.toString(), supplyPost: post.toString(), slot: '1', ts: '1' });
const burned = (mint: string, source: string, owner: string, amount: bigint, post: bigint): DecodedEvent => ev('burned', { mint, source, sourceOwner: owner, authority: owner, amount: amount.toString(), sourcePost: post.toString(), supplyPost: '0', slot: '1', ts: '1' });
const holdingCreated = (mint: string, holding: string, owner: string): DecodedEvent => ev('holdingCreated', { mint, holding, owner, payer: owner, ts: '1' });
const holdingClosed = (mint: string, holding: string, owner: string): DecodedEvent => ev('holdingClosed', { mint, holding, owner, ts: '1' });

const row = (r: { account: string; pre: string; post: string }): [string, string] => [r.pre, r.post];
const byAccount = <T extends { account: string }>(rows: T[], account: string): T => rows.find((r) => r.account === account)!;

describe('holdingBalanceChanges (the token events, no RPC)', () => {
  const mint = k();

  it('reads a plain transfer: the source lost the amount, the destination gained it', () => {
    const [source, destination, alice, bob] = [k(), k(), k(), k()];
    const keys = [k(), source, destination];
    const r = holdingBalanceChanges([transferred({ mint, source, destination, sourceOwner: alice, destinationOwner: bob, amount: 250_000n, sourcePost: 750_000n, destinationPost: 1_250_000n })], { [mint]: 6 }, keys);
    expect(r.changes.map((c) => [c.account, c.pre, c.post, c.change, c.accountIndex, c.owner, c.programId])).toEqual([
      [source, '1000000', '750000', '-250000', 1, alice, TOKEN],
      [destination, '1000000', '1250000', '250000', 2, bob, TOKEN],
    ]);
    // Solana's shape on both sides, the ui strings exact.
    expect(r.preTokenBalances).toEqual([
      { accountIndex: 1, account: source, mint, owner: alice, programId: TOKEN, uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' } },
      { accountIndex: 2, account: destination, mint, owner: bob, programId: TOKEN, uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' } },
    ]);
    expect(r.postTokenBalances.map((b) => b.uiTokenAmount)).toEqual([
      { amount: '750000', decimals: 6, uiAmount: 0.75, uiAmountString: '0.75' },
      { amount: '1250000', decimals: 6, uiAmount: 1.25, uiAmountString: '1.25' },
    ]);
    expect(r.decimalsBy).toEqual({ [mint]: 6 });
  });

  it('keeps the hook deltas from the destination: each cut holding gained its amount, the destination the rest', () => {
    const [source, destination, fee, vault] = [k(), k(), k(), k()];
    const r = holdingBalanceChanges(
      [transferred({ mint, source, destination, sourceOwner: k(), destinationOwner: k(), amount: 1_000n, sourcePost: 9_000n, destinationPost: 985n, deltas: [{ holding: fee, owner: k(), amount: 10n, post: 110n }, { holding: vault, owner: k(), amount: 5n, post: 5n }] })],
      { [mint]: 0 },
    );
    expect(row(byAccount(r.changes, source))).toEqual(['10000', '9000']);
    expect(row(byAccount(r.changes, destination))).toEqual(['0', '985']);
    expect(row(byAccount(r.changes, fee))).toEqual(['100', '110']);
    expect(row(byAccount(r.changes, vault))).toEqual(['0', '5']);
    // Conservation: what the source lost, the others gained.
    expect(r.changes.reduce((sum, c) => sum + BigInt(c.change), 0n)).toBe(0n);
    // No keys given: no account index.
    expect(r.changes.every((c) => c.accountIndex === -1)).toBe(true);
  });

  it('reads a mint into a holding created in the transaction: no pre entry, like a new token account', () => {
    const [holding, owner] = [k(), k()];
    const r = holdingBalanceChanges([holdingCreated(mint, holding, owner), minted(mint, holding, owner, 5_000_000n, 5_000_000n)], { [mint]: 6 });
    expect(r.changes).toEqual([expect.objectContaining({ account: holding, owner, pre: '0', post: '5000000', change: '5000000', created: true, closed: false, uiPostAmountString: '5' })]);
    expect(r.preTokenBalances).toEqual([]);
    expect(r.postTokenBalances.map((b) => [b.account, b.uiTokenAmount.amount])).toEqual([[holding, '5000000']]);
  });

  it('reads a burn: the source had the amount more, and a holding closed after it has no post entry', () => {
    const [holding, owner] = [k(), k()];
    const r = holdingBalanceChanges([burned(mint, holding, owner, 40n, 60n)], { [mint]: 2 });
    expect(r.changes).toEqual([expect.objectContaining({ account: holding, pre: '100', post: '60', change: '-40', uiPreAmountString: '1', uiPostAmountString: '0.6' })]);
    const closed = holdingBalanceChanges([burned(mint, holding, owner, 100n, 0n), holdingClosed(mint, holding, owner)], { [mint]: 2 });
    expect(closed.changes).toEqual([expect.objectContaining({ pre: '100', post: '0', closed: true })]);
    expect(closed.preTokenBalances.map((b) => b.uiTokenAmount.amount)).toEqual(['100']);
    expect(closed.postTokenBalances).toEqual([]);
    // Created and closed in one transaction: nothing to report.
    expect(holdingBalanceChanges([holdingCreated(mint, holding, owner), holdingClosed(mint, holding, owner)], { [mint]: 2 }).changes).toEqual([]);
  });

  it('chains several events on one holding in order: the first gives its pre, the last its post', () => {
    const [wallet, fee, vault, owner] = [k(), k(), k(), k()];
    // A buy as the launchpad does it: 0.1 SOL minted into the wallet's bridged-SOL holding, the creator fee out, the rest to the pool.
    const events = [
      minted(mint, wallet, owner, 100_000_000n, 100_000_000n),
      transferred({ mint, source: wallet, destination: fee, sourceOwner: owner, destinationOwner: k(), amount: 500_000n, sourcePost: 99_500_000n, destinationPost: 500_000n }),
      transferred({ mint, source: wallet, destination: vault, sourceOwner: owner, destinationOwner: k(), amount: 99_500_000n, sourcePost: 0n, destinationPost: 2_099_500_000n }),
    ];
    const r = holdingBalanceChanges(events, { [mint]: 9 });
    expect(row(byAccount(r.changes, wallet))).toEqual(['0', '0']);
    expect(byAccount(r.changes, wallet).change).toBe('0');
    expect(row(byAccount(r.changes, fee))).toEqual(['0', '500000']);
    expect(row(byAccount(r.changes, vault))).toEqual(['2000000000', '2099500000']);
    expect(byAccount(r.postTokenBalances, vault).uiTokenAmount).toEqual({ amount: '2099500000', decimals: 9, uiAmount: 2.0995, uiAmountString: '2.0995' });
    // The wallet's holding existed before (no HoldingCreated), so it has a pre entry of 0, with uiAmount null as the RPC writes zero.
    expect(byAccount(r.preTokenBalances, wallet).uiTokenAmount).toEqual({ amount: '0', decimals: 9, uiAmount: null, uiAmountString: '0' });
    // Supply grew by the mint: the changes add up to it.
    expect(r.changes.reduce((sum, c) => sum + BigInt(c.change), 0n)).toBe(100_000_000n);
  });

  it('takes decimals from a MintCreated in the same transaction, and never guesses them otherwise', () => {
    const [created, holding, owner] = [k(), k(), k()];
    const mintCreated = ev('mintCreated', { mint: created, creator: owner, decimals: 3, maxSupply: '0', mintAuthority: owner, freezeAuthority: null, hookAuthority: null, metadataAuthority: null, hookProgram: null, hookFlags: 0, name: 'N', symbol: 'S', uri: 'u', ts: '1' });
    const r = holdingBalanceChanges([mintCreated, minted(created, holding, owner, 12_345n, 12_345n)]);
    expect([r.decimalsBy, r.changes[0]?.uiPostAmountString]).toEqual([{ [created]: 3 }, '12.345']);
    const other = k();
    expect(() => holdingBalanceChanges([minted(other, holding, owner, 1n, 1n)])).toThrow(MissingDecimalsError);
    try {
      holdingBalanceChanges([minted(other, holding, owner, 1n, 1n), minted(created, holding, owner, 1n, 1n)], { [created]: 3 });
    } catch (error) {
      expect((error as MissingDecimalsError).mints).toEqual([other]);
      expect((error as Error).message).toContain(other);
    }
    // Events of other programs are not balance changes.
    expect(holdingBalanceChanges([{ ordinal: 0, program: 'swap', programId: a.SWAP_PROGRAM.toBase58(), name: 'swapped', data: {} }]).changes).toEqual([]);
  });
});

describe('uiAmountString', () => {
  it('writes the exact decimal the RPC would, trailing zeros trimmed', () => {
    expect(uiAmountString(100_000_000n, 9)).toBe('0.1');
    expect(uiAmountString(0n, 6)).toBe('0');
    expect(uiAmountString(2_174_548_467_223n, 6)).toBe('2174548.467223');
    expect(uiAmountString(750_000_000_000_000n, 6)).toBe('750000000');
    expect(uiAmountString(7n, 0)).toBe('7');
    expect(uiAmountString(-1_500n, 3)).toBe('-1.5');
    expect(uiAmountString(1n, 12)).toBe('0.000000000001');
  });
});

// ---- the transaction encodings -----------------------------------------------------------------------

/** An event as the program emits it, base58 as the RPC's `json` encoding gives inner instruction data. */
function emitted(name: string, value: Record<string, unknown>): string {
  const idl = (IDL.token as unknown as { events: { name: string; discriminator: number[] }[] }).events;
  const disc = idl.find((e) => e.name === name.charAt(0).toUpperCase() + name.slice(1))!.discriminator;
  return bs58.encode(Buffer.concat([EVENT_IX_TAG, Buffer.from(disc), CODERS.token.types.encode(name, value)]));
}

const EVENT_AUTHORITY = a.eventAuthority(a.TOKEN_PROGRAM);

describe('tokenBalanceChanges (any transaction encoding)', () => {
  const mint = Keypair.generate().publicKey;
  const [source, destination, alice, bob] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const transfer = emitted('transferred', { mint, source, destination, sourceOwner: alice, destinationOwner: bob, authority: alice, amount: bn(1_000_000), deltas: [], sourcePost: bn(0), destinationPost: bn(1_000_000), slot: bn(1), ts: bn(1) });
  const expected = { pre: [[source.toBase58(), '1000000'], [destination.toBase58(), '0']], post: [[source.toBase58(), '0'], [destination.toBase58(), '1000000']] };
  const sides = (r: { preTokenBalances: HoldingTokenBalance[]; postTokenBalances: HoldingTokenBalance[] }) => ({ pre: r.preTokenBalances.map((b) => [b.account, b.uiTokenAmount.amount]), post: r.postTokenBalances.map((b) => [b.account, b.uiTokenAmount.amount]) });

  it('reads the RPC’s raw json reply, with the lookup table’s addresses after the static keys', async () => {
    const tx: TransactionLike = {
      slot: 5,
      blockTime: 1,
      transaction: { message: { accountKeys: [a.TOKEN_PROGRAM.toBase58(), alice.toBase58(), source.toBase58()] } },
      meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [4], data: transfer }] }], loadedAddresses: { writable: [destination.toBase58()], readonly: [EVENT_AUTHORITY.toBase58()] } },
    };
    const r = await tokenBalanceChanges(tx, { decimalsOf: (m) => (m === mint.toBase58() ? 6 : 0) });
    expect(sides(r)).toEqual(expected);
    expect(r.changes.map((c) => c.accountIndex)).toEqual([2, 3]);
    // A mint the transaction does not create and the caller cannot name: refused by name, never 6.
    await expect(tokenBalanceChanges(tx)).rejects.toBeInstanceOf(MissingDecimalsError);
    await expect(tokenBalanceChanges(tx, { decimalsOf: () => 13 })).rejects.toBeInstanceOf(MissingDecimalsError);
  });

  it('reads web3.js’s VersionedTransactionResponse (static keys, loaded addresses as PublicKeys)', async () => {
    const tx: TransactionLike = {
      slot: 5,
      transaction: { message: { staticAccountKeys: [a.TOKEN_PROGRAM, EVENT_AUTHORITY, source, destination] } },
      meta: { err: null, innerInstructions: [{ index: 2, instructions: [{ programIdIndex: 0, accounts: [1], data: transfer }] }], loadedAddresses: { writable: [], readonly: [] } },
    };
    expect(sides(await tokenBalanceChanges(tx, { decimalsOf: () => 6 }))).toEqual(expected);
  });

  it('reads the jsonParsed encoding (keys as {pubkey}, instructions by program id), and a MintCreated in the transaction', async () => {
    const created = emitted('mintCreated', { mint, creator: alice, decimals: 9, maxSupply: bn(0), mintAuthority: alice, freezeAuthority: null, hookAuthority: null, metadataAuthority: null, hookProgram: null, hookFlags: 0, name: 'N', symbol: 'S', uri: 'u', ts: bn(1) });
    const tx: TransactionLike = {
      slot: 5,
      transaction: { message: { accountKeys: [{ pubkey: alice }, { pubkey: a.TOKEN_PROGRAM }, { pubkey: EVENT_AUTHORITY }, { pubkey: source }, { pubkey: destination }] } },
      meta: {
        err: null,
        innerInstructions: [{ index: 0, instructions: [{ programId: PublicKey.default, parsed: { type: 'createAccount' } }, { programId: a.TOKEN_PROGRAM, accounts: [EVENT_AUTHORITY], data: created }, { programId: a.TOKEN_PROGRAM, accounts: [EVENT_AUTHORITY], data: transfer }] }],
      },
    };
    const r = await tokenBalanceChanges(tx);
    expect(sides(r)).toEqual(expected);
    expect(r.decimalsBy).toEqual({ [mint.toBase58()]: 9 });
    expect(r.postTokenBalances[1]?.uiTokenAmount.uiAmountString).toBe('0.001');
  });

  it('answers empty for a failed transaction (nothing moved), and reads decimals over a connection once per mint', async () => {
    const failed: TransactionLike = { transaction: { message: { accountKeys: [] } }, meta: { err: { InstructionError: [0, 'Custom'] }, innerInstructions: [] } };
    expect(await tokenBalanceChanges(failed)).toEqual({ changes: [], preTokenBalances: [], postTokenBalances: [], decimalsBy: {} });
    const tx: TransactionLike = {
      transaction: { message: { accountKeys: [a.TOKEN_PROGRAM.toBase58(), EVENT_AUTHORITY.toBase58()] } },
      meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [1], data: transfer }, { programIdIndex: 0, accounts: [1], data: transfer }] }] },
    };
    let reads = 0;
    const mintData = await CODERS.token.accounts.encode('mint', { version: 1, decimals: 4, supply: bn(0), maxSupply: bn(0), mintAuthority: null, freezeAuthority: null, hookAuthority: null, metadataAuthority: null, hookProgram: null, hookFlags: 0, name: 'N', symbol: 'S', uri: 'u', createdAt: bn(1), creator: alice, hookSignerBump: 0, reserved: Array(31).fill(0) });
    const connection = {
      getAccountInfo: async (key: PublicKey) => {
        reads += 1;
        return key.equals(mint) ? { owner: a.TOKEN_PROGRAM, data: mintData, executable: false, lamports: 1, rentEpoch: 0 } : null;
      },
    } as unknown as Connection;
    const r = await tokenBalanceChanges(tx, { connection });
    // One read for the mint, whatever the number of events on it; the first event gives the pre (1,000,000 at 4 decimals).
    expect([reads, r.decimalsBy[mint.toBase58()], r.changes[0]?.uiPreAmountString]).toEqual([1, 4, '100']);
    // Not a mint of the token program: refused, not guessed.
    const unknown: TransactionLike = { ...tx, meta: { ...tx.meta!, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [1], data: emitted('minted', { mint: Keypair.generate().publicKey, destination: source, destinationOwner: alice, authority: alice, amount: bn(1), destinationPost: bn(1), supplyPost: bn(1), slot: bn(1), ts: bn(1) }) }] }] } };
    await expect(tokenBalanceChanges(unknown, { connection })).rejects.toBeInstanceOf(MissingDecimalsError);
    // Inner instructions the node did not record: said so, rather than an empty answer.
    await expect(tokenBalanceChanges({ ...tx, meta: { err: null, innerInstructions: null } })).rejects.toThrow(/innerInstructions/);
  });
});

// ---- shapes hold at the type level: web3.js's responses go in, its TokenBalance comes out ----------------

export function shapes(tx: VersionedTransactionResponse, parsed: ParsedTransactionWithMeta, balance: HoldingTokenBalance): [TransactionLike, TransactionLike, TokenBalance] {
  return [tx, parsed, balance];
}

/** The sample on /docs/build and in the README, line for line (BuildSections.tsx `BALANCES`), so it keeps typechecking. */
export async function docsSample(RPC_URL: string, signature: string): Promise<HoldingTokenBalance[]> {
  const connection = new Connection(RPC_URL);
  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  const { preTokenBalances, postTokenBalances, decimalsBy } = await tokenBalanceChanges(tx!, { connection });
  for (const b of postTokenBalances) console.log(b.account, b.owner, b.uiTokenAmount.uiAmountString, decimalsBy[b.mint]);
  return preTokenBalances;
}
