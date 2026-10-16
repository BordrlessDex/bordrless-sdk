/**
 * A launch's creator fee and companion fee, read from the chain and from the API; and the fee
 * helpers of @bordrless/shared (`fees.ts`), re-exported.
 */
import { PublicKey } from '@solana/web3.js';
import { feesOfSplit, type ConfigInspection, type LaunchFees } from '@bordrless/shared';
import type { Launch } from './accounts.ts';
import type { Companion } from './companion.ts';

export {
  SCRIPT_AUTHOR_SHARE_BPS,
  SCRIPT_PAYOUT_OPEN,
  claimBeneficiaryPart,
  feeSplitOf,
  feesOfSplit,
  launcherShareOfFees,
  scriptAuthorShare,
  type CompanionFeeParts,
  type LaunchFees,
} from '@bordrless/shared';

/** The script approver: the hot key that approves companion scripts and, beside the launcher, may set a script's payout terms (`set_payout_terms`). */
export const SCRIPT_APPROVER = new PublicKey('3onVUMKmJYmEqLpbUTv1bdLixowHJyiRPF4ApEW8ipJW');

/** A launch's creator fee and companion fee from `decodeLaunch` and `decodeCompanion` (null: no companion, the whole fee is the creator fee). */
export const launchFeesOf = (launch: Pick<Launch, 'creatorFeeBps'>, companion: Pick<Companion, 'split'> | null | undefined): LaunchFees =>
  feesOfSplit(launch.creatorFeeBps, companion ? companion.split.beneficiaryBps : 10_000);

/** A pair config's fixed launcher share (keeper.json `launcherShareBps`, basis points of the whole fee) from the API's `ConfigInspection`; null when the config has no pair script or its builder fixed none. Not on chain until a launch is made. */
export const pairLauncherShareBps = (inspection: Pick<ConfigInspection, 'requiredCompanion'> | null | undefined): number | null => {
  const r = inspection?.requiredCompanion;
  return r?.kind === 'script' ? (r.keeper?.launcherShareBps ?? null) : null;
};
