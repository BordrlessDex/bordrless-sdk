/**
 * Build your own (docs/hooks-v2.md §5.7, §5.8), read and checked the way `create_config` and
 * `create_launch` check it, before anything is signed: a `LaunchConfig` by its key (the rules
 * against the launch config's bounds, the creator fee, the custom hook's rules), a hook program
 * (deployed, none of the protocol's, who can upgrade it: immutable, or only Bordrless Studio's key
 * or the protocol's, as `create_config` requires) and whether the hook has been prepared for
 * a mint (its registry at `["bordrless-hook-accounts", mint]`). Every problem is one plain sentence,
 * the same the launch form shows. And the one-call way to make a config: a fresh keypair, the
 * instruction, and the key to paste.
 */
import { Keypair, PublicKey, type AccountInfo, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { HOOK_AUTHORITY_PROBLEM, HOOK_UPGRADE_AUTHORITIES, PROGRAM_IDS, TOKEN_HOOK_FLAGS_ALL, checkLaunchRules, hookAuthorityAccepted, kitModules, type LaunchRulesInput } from '@bordrless/shared';
import { HALF_LIFE_PROGRAM, LAUNCH_CONFIG, LAUNCH_PROGRAM, TAX_HOOK_PROGRAM, programDataAddress, registryAddress, BPF_LOADER_UPGRADEABLE, SYSTEM_PROGRAM } from './addresses.ts';
import { LAUNCH_CONFIG_LABEL_MAX, decodeLaunchConfig, decodeLaunchConfigAccount, launchRulesInputOf, type LaunchConfig, type LaunchConfigAccount, type LaunchRulesData } from './accounts.ts';
import { MAX_CUSTOM_HOOK_EXTRAS, decodeHookAccountList, resolveCustomHookAccounts, type CustomHookAccounts, type HookAccountList } from './hooks.ts';
import { halfLife as halfLifeIx, launch, type CreateConfigArgs } from './instructions.ts';

/** The programs a custom hook may not be (§5.8, `PROTOCOL_PROGRAMS`): the protocol's own, the system program and the default key. */
export const PROTOCOL_PROGRAMS: readonly PublicKey[] = [PROGRAM_IDS.token, PROGRAM_IDS.swap, PROGRAM_IDS.bridge, PROGRAM_IDS.launch, PROGRAM_IDS.kit].map((id) => new PublicKey(id)).concat(SYSTEM_PROGRAM, PublicKey.default);

/** `tax_hook` is the worked example, the one hook of the repository a creator may name as their own. */
export const EXAMPLE_HOOK = TAX_HOOK_PROGRAM;

// ---- a program's upgrade authority ----------------------------------------------------------------------

export interface ProgramUpgradeInfo {
  /** The account exists and is a program. */
  executable: boolean;
  /** Who can upgrade it; null when nobody can (or it could not be read). */
  upgradeAuthority: PublicKey | null;
  /** Whether it can still be upgraded; null when it could not be told. */
  upgradeable: boolean | null;
}

const PROGRAM_TAG = 2;
const PROGRAM_DATA_TAG = 3;
const OPTION_AT = 12;

/** The upgrade authority a ProgramData account holds: null for none (final), undefined when the bytes are not one. */
export function upgradeAuthorityOf(data: Buffer): PublicKey | null | undefined {
  if (data.length < OPTION_AT + 1 || data.readUInt32LE(0) !== PROGRAM_DATA_TAG) return undefined;
  const tag = data[OPTION_AT];
  if (tag === 0) return null;
  if (tag !== 1 || data.length < OPTION_AT + 33) return undefined;
  return new PublicKey(data.subarray(OPTION_AT + 1, OPTION_AT + 33));
}

/** A program's upgrade info from its account and its ProgramData account (null when either is not that). */
export function programUpgradeInfoOf(program: AccountInfo<Buffer> | null, programData: AccountInfo<Buffer> | null): ProgramUpgradeInfo {
  if (!program || !program.executable) return { executable: false, upgradeAuthority: null, upgradeable: null };
  if (!program.owner.equals(BPF_LOADER_UPGRADEABLE)) return { executable: true, upgradeAuthority: null, upgradeable: false };
  if (program.data.length < 36 || program.data.readUInt32LE(0) !== PROGRAM_TAG || !programData || !programData.owner.equals(BPF_LOADER_UPGRADEABLE)) return { executable: true, upgradeAuthority: null, upgradeable: null };
  const authority = upgradeAuthorityOf(programData.data);
  if (authority === undefined) return { executable: true, upgradeAuthority: null, upgradeable: null };
  return { executable: true, upgradeAuthority: authority, upgradeable: authority !== null };
}

/**
 * Why `create_config` would refuse this hook for who can upgrade it, or null: a custom hook must be
 * immutable, or upgradeable only by Bordrless Studio's upgrade key or the protocol's
 * (`HOOK_UPGRADE_AUTHORITIES`), so it can never be swapped for other code after its token launched.
 */
export function hookAuthorityProblem(info: ProgramUpgradeInfo): string | null {
  if (!info.executable || info.upgradeable !== true || !info.upgradeAuthority) return null;
  if (HOOK_UPGRADE_AUTHORITIES.includes(info.upgradeAuthority.toBase58())) return null;
  return `Anyone holding ${info.upgradeAuthority.toBase58()} could change this hook after launch. Make it immutable first (solana program set-upgrade-authority <program> --final), or deploy it with Bordrless Studio.`;
}

/** Reads a program and its ProgramData account in one round trip. */
export async function fetchProgramUpgradeInfo(connection: Connection, program: PublicKey): Promise<ProgramUpgradeInfo> {
  const [p, d] = await connection.getMultipleAccountsInfo([program, programDataAddress(program)], 'confirmed');
  return programUpgradeInfoOf(p ?? null, d ?? null);
}

/**
 * Whether the launch program accepts a config's own hook for who can upgrade it
 * (`hookAuthorityAccepted` in @bordrless/shared): no hook, an immutable one, or one only Bordrless
 * Studio's key or the protocol's can upgrade. Only a known outside authority is refused.
 */
export function hookAcceptedBy(hook: PublicKey | null, info: ProgramUpgradeInfo | null): boolean {
  return hookAuthorityAccepted(hook?.toBase58() ?? null, info ? { upgradeAuthority: info.upgradeAuthority?.toBase58() ?? null, upgradeable: info.upgradeable } : null);
}

// ---- checking a config as the programs do ------------------------------------------------------------------

/** The custom-hook rules of `create_config` and `create_launch` (§5.8), on what the program account shows; each sentence as the form prints it. */
export function customHookProblems(hook: PublicKey | null, flags: number, rules: LaunchRulesData, program: Pick<AccountInfo<Buffer>, 'executable'> | null): string[] {
  const out: string[] = [];
  if (hook === null) {
    if (flags !== 0) out.push('Hook flags were set without a hook.');
    return out;
  }
  if (kitModules(launchRulesInputOf(rules)) !== 0) out.push('A config with a custom hook can’t have holder rewards, max wallet or the locks: one token hook per mint. Burn and the creator fee are fine.');
  if (PROTOCOL_PROGRAMS.some((p) => p.equals(hook))) out.push('The hook must be a program of your own, not one of Bordrless’s.');
  else if (!program || !program.executable) out.push('The hook program is not deployed on this cluster.');
  if (flags === 0 || (flags & ~TOKEN_HOOK_FLAGS_ALL) !== 0) out.push('The hook’s flags must name at least one callback it runs on, with no unknown bit.');
  return out;
}

/** Why `create_config` would refuse these arguments under `config` (the launch program's `Config`), one sentence each; empty when it takes them. */
export function configProblems(args: Pick<CreateConfigArgs, 'rules' | 'creatorFeeBps' | 'customHook' | 'customHookFlags' | 'label'>, config: Pick<LaunchConfig, 'ruleBounds' | 'maxCreatorFeeBps'>, hookProgram: Pick<AccountInfo<Buffer>, 'executable'> | null): string[] {
  const out: string[] = [];
  if (Buffer.byteLength(args.label, 'utf8') > LAUNCH_CONFIG_LABEL_MAX) out.push(`The label is at most ${LAUNCH_CONFIG_LABEL_MAX} bytes.`);
  if (args.creatorFeeBps > config.maxCreatorFeeBps) out.push(`The creator fee can be at most ${config.maxCreatorFeeBps / 100}%.`);
  const rules = launchRulesInputOf(args.rules);
  const bounds = checkLaunchRules(rules, args.creatorFeeBps, config.ruleBounds);
  if (bounds) out.push(bounds);
  out.push(...customHookProblems(args.customHook, args.customHookFlags, args.rules, hookProgram));
  return out;
}

/** A registry too long for a launch to fit one transaction (`MAX_CUSTOM_HOOK_EXTRAS`), as one sentence; null when it fits. */
export function registryLengthProblem(list: Pick<HookAccountList, 'accounts'>): string | null {
  const n = list.accounts.length;
  return n > MAX_CUSTOM_HOOK_EXTRAS ? `The hook’s registry lists ${n} accounts; a launch fits at most ${MAX_CUSTOM_HOOK_EXTRAS} in one transaction.` : null;
}

/** What `inspectConfig` found. */
export interface ConfigInspectionResult {
  address: PublicKey;
  config: LaunchConfigAccount;
  rules: LaunchRulesInput;
  /** Why it could not launch as it is (the bounds now, the creator fee, the hook), one sentence each; empty when it could. */
  problems: string[];
  /** The custom hook program's upgrade info; null without a hook. */
  hook: ProgramUpgradeInfo | null;
  /**
   * The launch program accepts the hook for who can upgrade it (`hookAcceptedBy`): immutable, or
   * only Bordrless Studio's key or the protocol's. True without a hook. When false, `problems` holds
   * `HOOK_AUTHORITY_PROBLEM` (unless the hook is not even deployed, which says so instead).
   */
  hookAccepted: boolean;
  /** With a hook and a mint: the hook's accounts resolved from its registry for the mint, or null when the hook has not been prepared for it. */
  hookAccounts: CustomHookAccounts | null;
  /** With a hook and a mint: whether the registry exists; null otherwise. */
  registryReady: boolean | null;
  /**
   * The hook is Half-Life (programs/half_life): the launch itself prepares it for the mint and
   * lights its furnace, so a missing registry is no problem and `hookAccounts` are built without it.
   */
  halfLife: boolean;
}

/**
 * Reads a `LaunchConfig` by its key and checks it as `create_launch` would, now (the launch config's
 * bounds may have changed since it was made): two round trips at most. With `mint`, also whether a
 * custom hook has been prepared for that mint (its registry), and the hook's accounts. A hook someone
 * outside Bordrless can upgrade is a problem (`hookAccepted`). Null when no `LaunchConfig` lives at
 * the address.
 */
export async function inspectConfig(connection: Connection, address: PublicKey, mint: PublicKey | null = null): Promise<ConfigInspectionResult | null> {
  const [configInfo, launchConfigInfo] = await connection.getMultipleAccountsInfo([address, LAUNCH_CONFIG], 'confirmed');
  if (!configInfo || !configInfo.owner.equals(LAUNCH_PROGRAM)) return null;
  let config: LaunchConfigAccount;
  try {
    config = decodeLaunchConfigAccount(configInfo.data);
  } catch {
    return null;
  }
  const problems: string[] = [];
  const rules = launchRulesInputOf(config.rules);
  const launchConfig = launchConfigInfo && launchConfigInfo.owner.equals(LAUNCH_PROGRAM) ? decodeLaunchConfig(launchConfigInfo.data) : null;
  if (!launchConfig) problems.push('The launchpad is not configured on this cluster yet.');
  else {
    if (config.creatorFeeBps > launchConfig.maxCreatorFeeBps) problems.push(`The creator fee can be at most ${launchConfig.maxCreatorFeeBps / 100}%.`);
    const bounds = checkLaunchRules(rules, config.creatorFeeBps, launchConfig.ruleBounds);
    if (bounds) problems.push(bounds);
  }
  let hook: ProgramUpgradeInfo | null = null;
  let hookAccounts: CustomHookAccounts | null = null;
  let registryReady: boolean | null = null;
  let hookAccepted = true;
  const halfLife = config.customHook !== null && config.customHook.equals(HALF_LIFE_PROGRAM);
  if (config.customHook) {
    const keys = [config.customHook, programDataAddress(config.customHook), ...(mint ? [registryAddress(config.customHook, mint)] : [])];
    const [programInfo, programData, registryInfo] = await connection.getMultipleAccountsInfo(keys, 'confirmed');
    hook = programUpgradeInfoOf(programInfo ?? null, programData ?? null);
    problems.push(...customHookProblems(config.customHook, config.customHookFlags, config.rules, programInfo ?? null));
    hookAccepted = hookAcceptedBy(config.customHook, hook);
    // One sentence: a hook that is not deployed already says so.
    if (!hookAccepted && hook.executable) problems.push(HOOK_AUTHORITY_PROBLEM);
    if (mint) {
      const list = registryInfo && registryInfo.owner.equals(config.customHook) ? decodeHookAccountList(registryInfo.data) : null;
      registryReady = list !== null;
      // Half-Life's registry is the same for every mint and its `prepare` is permissionless: the launch prepares it.
      if (!list && halfLife) hookAccounts = halfLifeIx.accounts(mint);
      else if (!list) {
        // A hook the site refuses can't launch, prepared or not: its one sentence says so, not this one.
        if (hookAccepted) problems.push('Prepare the hook for this mint first: its registry at ["bordrless-hook-accounts", mint] does not exist yet.');
      } else {
        const long = registryLengthProblem(list);
        if (long) problems.push(long);
        try {
          hookAccounts = resolveCustomHookAccounts(config.customHook, list, mint);
        } catch (error) {
          problems.push(error instanceof Error ? `${error.message}.` : 'The hook’s registry cannot be resolved for a launch.');
        }
      }
    }
  } else problems.push(...customHookProblems(null, config.customHookFlags, config.rules, null));
  return { address, config, rules, problems, hook, hookAccepted, hookAccounts, registryReady, halfLife };
}

/** What `inspectTokenHook` found about a hook program for a mint. */
export interface TokenHookInspection {
  program: PublicKey;
  info: ProgramUpgradeInfo;
  /** The hook is none of the protocol's programs. */
  ownProgram: boolean;
  /** The launch program accepts it for who can upgrade it (`hookAcceptedBy`). */
  accepted: boolean;
  /** The registry for `mint` exists and decodes. */
  registryReady: boolean;
  /** The accounts resolved for the launch, or null when the registry is missing or cannot serve a launch. */
  accounts: CustomHookAccounts | null;
  problems: string[];
}

/**
 * A hook program and whether it has been prepared for `mint` (§5.8): deployed, its own, upgradeable
 * by nobody or only by Bordrless (`hookAuthorityProblem`), its registry present and usable for a
 * launch.
 */
export async function inspectTokenHook(connection: Connection, program: PublicKey, mint: PublicKey): Promise<TokenHookInspection> {
  const [programInfo, programData, registryInfo] = await connection.getMultipleAccountsInfo([program, programDataAddress(program), registryAddress(program, mint)], 'confirmed');
  const info = programUpgradeInfoOf(programInfo ?? null, programData ?? null);
  const ownProgram = !PROTOCOL_PROGRAMS.some((p) => p.equals(program));
  const accepted = hookAcceptedBy(program, info);
  const problems: string[] = [];
  if (!ownProgram) problems.push('The hook must be a program of your own, not one of Bordrless’s.');
  else if (!info.executable) problems.push('The hook program is not deployed on this cluster.');
  const authority = ownProgram ? hookAuthorityProblem(info) : null;
  if (authority) problems.push(authority);
  const list = registryInfo && registryInfo.owner.equals(program) ? decodeHookAccountList(registryInfo.data) : null;
  let accounts: CustomHookAccounts | null = null;
  if (!list) problems.push('Prepare the hook for this mint first: its registry at ["bordrless-hook-accounts", mint] does not exist yet.');
  else {
    const long = registryLengthProblem(list);
    if (long) problems.push(long);
    try {
      accounts = resolveCustomHookAccounts(program, list, mint);
    } catch (error) {
      problems.push(error instanceof Error ? `${error.message}.` : 'The hook’s registry cannot be resolved for a launch.');
    }
  }
  return { program, info, ownProgram, accepted, registryReady: list !== null, accounts, problems };
}

// ---- making a config -------------------------------------------------------------------------------------

export interface BuiltConfig {
  /** The config's keypair: it signs `create_config` once, then is never needed again. */
  keypair: Keypair;
  /** The key to share and paste into the launch form. */
  address: PublicKey;
  instruction: TransactionInstruction;
}

/**
 * A `LaunchConfig` to create: a fresh keypair for the account, and the `create_config` instruction
 * signed by `creator` (the payer) and the keypair. Send it in any transaction; `address` is what the
 * launch form takes under "Build your own".
 */
export function buildCreateConfig(creator: PublicKey, args: CreateConfigArgs, keypair: Keypair = Keypair.generate()): BuiltConfig {
  return { keypair, address: keypair.publicKey, instruction: launch.createConfig(creator, keypair.publicKey, args) };
}
