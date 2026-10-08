/**
 * v0 transactions with the protocol lookup table (docs/hooks-v2.md §6; programs-summary §2.7). The
 * table holds the 22 fixed addresses no top-level instruction invokes; a v0 message loads from it
 * every account it uses that does not sign and is not invoked at top level, and keeps the rest in
 * its static keys. A program a transaction invokes at top level (compute budget, token, bridge, DEX,
 * launch, and the kit for claims and shares) always stays static: a v0 message cannot load an
 * invoked program from a table. `create_launch` with kit rules only fits with the table (1,043 bytes
 * with it, 1,366 without); so does one with a creator's own hook (1,077 with it, 1,339 without).
 */
import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { PROTOCOL_LOOKUP_TABLE } from './addresses.ts';

/** The largest serialized transaction (1,232 bytes). */
export const PACKET_DATA_SIZE = 1_232;
/** The most addresses one `extend_lookup_table` instruction carries here (well inside a transaction). */
const EXTEND_CHUNK = 20;

/**
 * An offline view of the protocol lookup table at `key` holding `addresses` (by default the 18 of
 * §6, in table order): enough to compile messages without fetching the table, provided the table on
 * chain holds the same addresses in the same order (`checkProtocolLookupTable`).
 */
export function protocolLookupTable(key: PublicKey, addresses: readonly PublicKey[] = PROTOCOL_LOOKUP_TABLE): AddressLookupTableAccount {
  return new AddressLookupTableAccount({ key, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [...addresses] } });
}

/** The protocol table's first 18 addresses: every prepared transaction but a companion launch fits with them. */
export const PROTOCOL_LOOKUP_TABLE_CORE = 18;

/**
 * Why a fetched lookup table cannot serve as the protocol table, or null when it can: it must hold
 * at least the first 18 addresses (`PROTOCOL_LOOKUP_TABLE_CORE`), and whatever more it holds must
 * be the next of `PROTOCOL_LOOKUP_TABLE`, at the indices the protocol uses (a message names table
 * entries by index); it must not be deactivated. A table of 18 still serves everything but a
 * companion launch (`companionReady`), so an older table keeps working while it is extended.
 */
export function checkProtocolLookupTable(table: AddressLookupTableAccount): string | null {
  if (!table.isActive()) return 'the lookup table is deactivated';
  const addresses = table.state.addresses;
  const held = Math.min(Math.max(addresses.length, PROTOCOL_LOOKUP_TABLE_CORE), PROTOCOL_LOOKUP_TABLE.length);
  for (let i = 0; i < held; i++) {
    const want = PROTOCOL_LOOKUP_TABLE[i]!;
    const got = addresses[i];
    if (!got || !got.equals(want)) return `the lookup table holds ${got ? got.toBase58() : 'nothing'} at index ${i}, not ${want.toBase58()}`;
  }
  return null;
}

/** Whether the protocol table holds the addresses a launch through a companion needs to fit (all of `PROTOCOL_LOOKUP_TABLE`). */
export const companionReady = (table: AddressLookupTableAccount): boolean => checkProtocolLookupTable(table) === null && table.state.addresses.length >= PROTOCOL_LOOKUP_TABLE.length;

/**
 * Compiles `instructions` into an unsigned v0 transaction paid by `payer`, loading from
 * `lookupTables` every account it can. Throws if a program an instruction invokes would not be a
 * static key (the runtime would refuse the transaction).
 */
export function buildV0Transaction(payer: PublicKey, instructions: TransactionInstruction[], recentBlockhash: string, lookupTables: AddressLookupTableAccount[]): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message(lookupTables);
  const statics = new Set(message.staticAccountKeys.map((k) => k.toBase58()));
  for (const ix of instructions) if (!statics.has(ix.programId.toBase58())) throw new Error(`${ix.programId.toBase58()} is invoked but not a static key`);
  return new VersionedTransaction(message);
}

/** The serialized size of a transaction, signatures included (zeros until signed). */
export const transactionSize = (tx: VersionedTransaction): number => tx.serialize().length;

/** The keys a v0 transaction's instructions index into: its static keys, and those it loads from tables. */
export function v0KeyCounts(tx: VersionedTransaction): { static: number; loaded: number; total: number } {
  const m = tx.message;
  const loaded = m.addressTableLookups.reduce((t, l) => t + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  return { static: m.staticAccountKeys.length, loaded, total: m.staticAccountKeys.length + loaded };
}

/**
 * The instructions that create the protocol lookup table and extend it with the 18 addresses, in
 * order (`pnpm admin init`), with the table's address. `recentSlot` is a recent slot (the table's
 * address derives from it). Send the creation first, then the extensions in order.
 */
export function createProtocolLookupTable(authority: PublicKey, payer: PublicKey, recentSlot: number, addresses: readonly PublicKey[] = PROTOCOL_LOOKUP_TABLE): { address: PublicKey; create: TransactionInstruction; extend: TransactionInstruction[] } {
  const [create, address] = AddressLookupTableProgram.createLookupTable({ authority, payer, recentSlot });
  return { address, create, extend: extendLookupTable(authority, payer, address, addresses) };
}

/** `extend_lookup_table` instructions adding `addresses` to `table`, in order, a chunk per instruction. */
export function extendLookupTable(authority: PublicKey, payer: PublicKey, table: PublicKey, addresses: readonly PublicKey[]): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  for (let i = 0; i < addresses.length; i += EXTEND_CHUNK) out.push(AddressLookupTableProgram.extendLookupTable({ authority, payer, lookupTable: table, addresses: addresses.slice(i, i + EXTEND_CHUNK) }));
  return out;
}
