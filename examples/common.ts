/**
 * What every example shares: a mainnet connection (set `RPC_URL` to your own RPC; the public one
 * rate-limits `getProgramAccounts`), the protocol lookup table, and argument parsing.
 */
import { Connection, PublicKey } from '@solana/web3.js';

export const connection = new Connection(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed');

/**
 * The protocol lookup table on mainnet-beta: the 18 fixed addresses every Bordrless swap uses
 * (`PROTOCOL_LOOKUP_TABLE` in @bordrless/sdk lists them; `checkProtocolLookupTable` checks a table).
 */
export const MAINNET_LOOKUP_TABLE = new PublicKey('4vxVcYLdkqT1rMfGHjAu4kMa9XSEhUdQU5ThVfU5grGQ');

/** The `index`-th command-line argument, or exit with `usage`. */
export function arg(index: number, usage: string): string {
  const value = process.argv[2 + index];
  if (!value) {
    console.error(`usage: node ${process.argv[1]?.split('/').pop()} ${usage}`);
    process.exit(2);
  }
  return value;
}

/** A raw amount as a decimal string with `decimals` places, trimmed. */
export function units(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const v = negative ? -raw : raw;
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
