/**
 * The lottery hook (`programs/lottery_hook`, `HqFWsC…`): a lottery coin's token hook under the game
 * ticket standard (`game.ts`). Every round, the tokens a holder has held since the round began are
 * their tickets, kept as a range in each holding's hook data; the coin's companion holds the pot,
 * draws a verifiable ticket once the round has ended and pays the holding whose range holds it.
 * The hook never sees SOL, never refuses a transfer and takes no cut. Mirrors
 * `lottery_hook::client`.
 *
 * For a launch through a companion: the setup transaction runs `companion.create`, then
 * `lotteryHook.prepare` (the mint's keypair signs, so only the launcher chooses its rounds), then
 * `companion.createGame`; the launch comes from a `LaunchConfig` naming this program with
 * `LOTTERY_HOOK_FLAGS`, its custom hook `lotteryHook.accounts(mint)`. `enter` registers a holding
 * that has not traded this round (anyone may send it for anyone; a keeper enters every holder once
 * a round).
 */
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import BN from 'bn.js';
import { LOTTERY_HOOK } from '@bordrless/shared';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { parseGameHeader, type GameHeader } from './game.ts';
import type { CustomHookAccounts } from './hooks.ts';

/** The flags a `LaunchConfig` names for the lottery hook: `BEFORE_TRANSFER | BEFORE_BURN | WRITES_HOOK_DATA` (145), exactly what a companion game launch accepts. */
export const LOTTERY_HOOK_FLAGS = LOTTERY_HOOK.flags;

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });

function build(name: string, args: Record<string, unknown>, keys: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: a.LOTTERY_HOOK_PROGRAM, keys: [...keys, ro(a.LOTTERY_EVENT_AUTHORITY), ro(a.LOTTERY_HOOK_PROGRAM)], data: CODERS.lotteryHook.instruction.encode(name, args) });
}

export const lotteryHook = {
  /**
   * `prepare(round_secs)` for `mint` (not created yet; its keypair signs), `payer` paying the rent:
   * the state at `["state", mint]` with the standard's header (rounds of `roundSecs`, an hour to 30
   * days) and the registry listing the state (w) and the launch (r). Once per mint.
   */
  prepare(payer: PublicKey, mint: PublicKey, roundSecs: number): TransactionInstruction {
    return build('prepare', { roundSecs }, [rw(payer, true), ro(mint, true), rw(a.lotteryStateAddress(mint)), rw(a.lotteryRegistryAddress(mint)), ro(a.SYSTEM_PROGRAM)]);
  },
  /**
   * `enter` for `owner`'s holding of `mint`: registers its whole balance for the current round when
   * it has not been written this round. Nobody signs; whoever pays the fee sends it. It changes
   * nothing for a holding written this round already or empty, and is refused for an owner that
   * can't hold tickets (the launch, its pool, the companion's creator address, a program's account).
   */
  enter(mint: PublicKey, owner: PublicKey): TransactionInstruction {
    return build('enter', {}, [rw(a.lotteryStateAddress(mint)), ro(mint), rw(a.holdingAddress(mint, owner)), ro(a.LOTTERY_HOOK_AUTHORITY), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY)]);
  },
  /** The hook's accounts for a prepared mint, without reading its registry: the state (w) and the launch (r), the registry's order (`lottery_hook::client::extras`). */
  accounts(mint: PublicKey): CustomHookAccounts {
    return { program: a.LOTTERY_HOOK_PROGRAM, extras: [rw(a.lotteryStateAddress(mint)), ro(a.launchAddress(mint))] };
  },
};

/** The lottery hook's state for a mint (`LotteryState` at `["state", mint]`): the standard's header first, then the hook's own fields. */
export interface LotteryState {
  header: GameHeader;
  version: number;
  bump: number;
  /** The launch (`["launch", mint]`): never holds tickets. */
  launch: PublicKey;
  /** The launch pool, remembered from the launch account on the first transfer after the launch (the default key until then). */
  pool: PublicKey;
  /** The companion's creator address: never holds tickets. */
  creator: PublicKey;
  preparedBy: PublicKey;
  preparedAt: number;
}

/** A `LotteryState` account (the discriminator checked by the coder; the header read at the standard's offsets). */
export function decodeLotteryState(data: Buffer): LotteryState {
  const r = CODERS.lotteryHook.accounts.decode('lotteryState', data) as Record<string, unknown>;
  return {
    header: parseGameHeader(data),
    version: Number(r.version),
    bump: Number(r.bump),
    launch: r.launch as PublicKey,
    pool: r.pool as PublicKey,
    creator: r.creator as PublicKey,
    preparedBy: r.preparedBy as PublicKey,
    preparedAt: Number((r.preparedAt as BN).toString()),
  };
}
