/**
 * The hook's SOL cut told apart in a companion's fee claim (2026-10-15): `FeesClaimed.fromHook`, appended to the event, and
 * `Companion.quoteCutClaimed`, appended to the account. Events and accounts from before read as they always did.
 */
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { decodeEventPayload, padOldEvent } from './events.ts';

const FEES_CLAIMED = Buffer.from([22, 104, 110, 222, 38, 157, 14, 62]);
const u64 = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

describe('FeesClaimed', () => {
  const companion = Keypair.generate().publicKey;
  const cranker = Keypair.generate().publicKey;
  const v1 = Buffer.concat([FEES_CLAIMED, companion.toBuffer(), u64(106_960_000_000n), u64(534_800_000n), u64(53_212_600_000n), u64(0n), u64(53_212_600_000n), cranker.toBuffer()]);

  it('reads fromHook when the event carries it', () => {
    const ev = decodeEventPayload('companion', Buffer.concat([v1, u64(45_193_000_000n)]));
    expect(ev?.name).toMatch(/^[fF]eesClaimed$/);
    expect(ev?.data).toMatchObject({ companion: companion.toBase58(), claimed: '106960000000', bounty: '534800000', toBeneficiary: '53212600000', cranker: cranker.toBase58(), fromHook: '45193000000' });
  });

  it('reads an event from before it as fromHook 0', () => {
    expect(padOldEvent('companion', v1).length).toBe(v1.length + 8);
    const ev = decodeEventPayload('companion', v1);
    expect(ev?.data).toMatchObject({ claimed: '106960000000', toBuyback: '53212600000', cranker: cranker.toBase58(), fromHook: '0' });
  });

  it('pads nothing else', () => {
    const other = Buffer.concat([Buffer.alloc(8, 1), v1.subarray(8)]);
    expect(padOldEvent('companion', other)).toBe(other);
    expect(padOldEvent('launch', v1)).toBe(v1);
  });
});
