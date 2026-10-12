/**
 * The explorer's words for the chain: each program's name, each IDL event's label in plain words
 * and the account it is mostly about, in one table the backend and the site both read (the backend
 * picks an event's subject with it; the site prints its label with the raw name as a title).
 *
 * Event names are the IDLs' (`packages/sdk/idl/*.json`), PascalCase; the SDK's coder gives them
 * camelCase, which `eventName` undoes. An event the table does not know keeps its raw name, spaced.
 */
import { PROGRAM_IDS } from './programs.ts';
import type { ExplorerProgram } from './api.ts';

/** Which group a program id belongs to: the five of Bordrless, or any other program the indexer follows (a token hook). */
export function explorerProgramOf(programId: string): ExplorerProgram {
  switch (programId) {
    case PROGRAM_IDS.token:
      return 'token';
    case PROGRAM_IDS.swap:
      return 'swap';
    case PROGRAM_IDS.bridge:
      return 'bridge';
    case PROGRAM_IDS.launch:
      return 'launch';
    case PROGRAM_IDS.kit:
      return 'kit';
    default:
      return 'hook';
  }
}

/** The groups' names, as the explorer's filter and its chips print them. */
export const EXPLORER_PROGRAM_NAMES: Readonly<Record<ExplorerProgram, string>> = { token: 'Token', swap: 'DEX', bridge: 'Bridge', launch: 'Launchpad', kit: 'Kit', hook: 'Hook' };

/** A program's name: one of the five, a hook Bordrless wrote, or "Hook" for any other. */
export function programLabel(programId: string): string {
  if (programId === PROGRAM_IDS.taxHook) return 'Tax hook';
  if (programId === PROGRAM_IDS.halfLife) return 'Half-Life';
  return EXPLORER_PROGRAM_NAMES[explorerProgramOf(programId)];
}

/** The IDL's PascalCase name from whatever case the coder stored (`transferred` -> `Transferred`). */
export const eventName = (raw: string): string => (raw ? `${raw.charAt(0).toUpperCase()}${raw.slice(1)}` : raw);

interface EventWords {
  label: string;
  /** The payload key naming the account the event is mostly about; null when it has none worth linking. */
  subject: string | null;
}

/** Every event of the IDLs, by its PascalCase name (`ConfigSet` is three programs' and reads the same). */
export const EVENT_WORDS: Readonly<Record<string, EventWords>> = {
  // token
  MintCreated: { label: 'Mint created', subject: 'mint' },
  HoldingCreated: { label: 'Holding opened', subject: 'holding' },
  Transferred: { label: 'Transfer', subject: 'mint' },
  Minted: { label: 'Mint', subject: 'mint' },
  Burned: { label: 'Burn', subject: 'mint' },
  HookSet: { label: 'Hook set', subject: 'mint' },
  AuthoritySet: { label: 'Authority set', subject: 'mint' },
  MetadataUpdated: { label: 'Metadata updated', subject: 'mint' },
  HoldingClosed: { label: 'Holding closed', subject: 'holding' },
  DelegateSet: { label: 'Delegate set', subject: 'holding' },
  FrozenSet: { label: 'Freeze changed', subject: 'holding' },
  HookDataWritten: { label: 'Hook data written', subject: 'holding' },
  // swap
  PoolCreated: { label: 'Pool created', subject: 'pool' },
  Swapped: { label: 'Swap', subject: 'pool' },
  LiquidityAdded: { label: 'Liquidity added', subject: 'pool' },
  LiquidityRemoved: { label: 'Liquidity removed', subject: 'pool' },
  CurveFinalized: { label: 'Curve finalized', subject: 'pool' },
  ProtocolFeesCollected: { label: 'Protocol fees collected', subject: 'pool' },
  ConfigSet: { label: 'Config set', subject: 'admin' },
  // launch
  LaunchCreated: { label: 'Launch created', subject: 'mint' },
  Graduated: { label: 'Graduated', subject: 'mint' },
  CreatorFeesClaimed: { label: 'Creator fees claimed', subject: 'mint' },
  LaunchConfigCreated: { label: 'Launch config created', subject: 'config' },
  // kit
  KitInstalled: { label: 'Rules installed', subject: 'mint' },
  KitGraduated: { label: 'Rules graduated', subject: 'mint' },
  RewardsClaimed: { label: 'Rewards claimed', subject: 'mint' },
  RewardsShared: { label: 'Rewards shared', subject: 'mint' },
  // bridge
  WrapperRegistered: { label: 'Wrapper registered', subject: 'wrappedMint' },
  Wrapped: { label: 'Bridged in', subject: 'wrappedMint' },
  Unwrapped: { label: 'Bridged out', subject: 'wrappedMint' },
  // half_life
  Stoked: { label: 'Exit fee burned', subject: 'mint' },
};

/** An event's label in plain words; an unknown event's name with its words spaced (`SomethingNew` -> "Something new"). */
export function eventLabel(name: string): string {
  const known = EVENT_WORDS[eventName(name)];
  if (known) return known.label;
  const spaced = eventName(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return `${spaced.charAt(0)}${spaced.slice(1).toLowerCase()}`;
}

/** The account an event is mostly about, read from its payload; null when the table names none or the payload lacks it. */
export function eventSubject(name: string, payload: Record<string, unknown>): string | null {
  const key = EVENT_WORDS[eventName(name)]?.subject;
  if (!key) return null;
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
