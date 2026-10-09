/**
 * Program addresses and the protocol's other fixed keys, the one place they are written down (the
 * same on mainnet, devnet and localnet: one set of program keypairs, generated 2026-10-07). Every
 * fixed key is a PDA with constant seeds; `packages/sdk` derives each again in its tests and fails
 * if one differs.
 */
export const PROGRAM_IDS = {
  token: '2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22',
  swap: 'GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk',
  bridge: 'CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7',
  launch: '1jcBymHxBjniZDhNPy51Vgm5Nz7pLUdxa9UBHc4TavC',
  taxHook: '8tjnVSreJGBRQFyDBf1SyyhBgLsdBxa2rHYh9sbxFyX7',
  /** The v2 token-rules hook (docs/hooks-v2.md §4): holder rewards, max wallet and the two locks. */
  kit: '14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH',
  /** Half-Life (programs/half_life): an exit fee that halves every six hours a token is held, burned. */
  halfLife: '53SpmtkdPWQ63mWoDeXk8P9tuwiT4ed2Wx4fwfy5NSF8',
  /** Companions (programs/bordrless_companion, docs/companions.md): a launch whose creator is a program, its fees bought back, shared with holders or vested by code. */
  companion: '6ZUM1gWBH9hBBNoJoaVAGwSftyZ6CUda6vUZTW9MsJuo',
  /**
   * The lottery hook (programs/lottery_hook, docs/companions.md "Games"): a lottery coin's token
   * hook under the game ticket standard; its companion holds the pot and draws. Not deployed yet
   * (2026-10-08): companion v2 and this hook go live together, after their audit.
   */
  lotteryHook: 'HqFWsCBQ416DAfevJ9TspyT5yXGGoYTCpcreiGkCgWcr',
} as const;

/**
 * The lottery hook's fixed facts (programs/lottery_hook/README.md): the flags a `LaunchConfig`
 * names for it (`BEFORE_TRANSFER | BEFORE_BURN | WRITES_HOOK_DATA`, exactly what a companion game
 * launch accepts), the token program's signer of its callbacks (`["hook-authority", hook]` under
 * the token program) and its own `["hook-authority"]`, which signs `write_hook_data` in `enter`.
 */
export const LOTTERY_HOOK = {
  program: PROGRAM_IDS.lotteryHook,
  flags: 145,
  tokenHookSigner: 'CFyuaxvKmpgnSMCoNqDKCcwxnTUeW8Mm1go1t3UMsvLH',
  hookAuthority: '6oZ9LkAfgmhmPYjXj3okjYK5sderddEo8fp8MR4H6Gx1',
  readme: 'https://github.com/BordrlessDex/bordrless-programs/tree/main/programs/lottery_hook',
  /**
   * The `LaunchConfig`s a lottery coin launches from, one per creator fee (basis points): each
   * names this hook with `flags`, no token rules and that creator fee, made by the protocol with
   * `pnpm admin lottery-configs` (which prints the lines to paste here). A creator fee without a
   * config can't launch a lottery coin yet: the launch form says so, the backend refuses it
   * (`lottery_off`). Created on mainnet 2026-10-09 by `pnpm admin lottery-configs`.
   */
  launchConfigs: {
    50: 'CYm9FNY49gV7wjukpYFqkm9u7FQLrjp2GexeHwbncf1L',
    100: 'GViQSt6znkGdiCrUYNTo3dJKMgfGS8eBHPSBjxfN2VS9',
    200: 'Ejo4Ehg4x16MeBKn3Y2f1NU31CoBjnby4kv75azUD8hU',
  } as Readonly<Partial<Record<number, string>>>,
} as const;

/** The creator fees (basis points) a lottery coin can launch with: those with a `LaunchConfig` in `LOTTERY_HOOK.launchConfigs`. */
export const lotteryFeeChoices = (): number[] => Object.keys(LOTTERY_HOOK.launchConfigs).map(Number).filter((bps) => bps > 0);

/**
 * Half-Life, Bordrless's own token hook (programs/half_life/README.md): the `LaunchConfig` the
 * launch form's Half-Life path launches from (no kit rules, creator fee 1%, the hook with
 * `flags`), and the fee curve the program has fixed: `maxFeePpm` for tokens that just arrived,
 * halved every `halfLifeSecs`, linear within each, zero from `zeroAfterSecs`.
 */
export const HALF_LIFE = {
  program: PROGRAM_IDS.halfLife,
  launchConfig: 'ABz5Je9FznnotUQxxaj28vn18t1Wv9SsDzEfDxGLRJY',
  /** `BEFORE_TRANSFER | TRANSFER_RETURNS_DELTA | WRITES_HOOK_DATA`. */
  flags: 193,
  creatorFeeBps: 100,
  maxFeePpm: 200_000,
  halfLifeSecs: 21_600,
  zeroAfterSecs: 172_800,
  /** The token program's signer of the hook's callbacks (`["hook-authority", half_life]`). */
  tokenHookSigner: 'FBZPj9PmV9dXL8U4qmRffXdXm11e23KEBnNgEVXxhfhF',
  readme: 'https://github.com/BordrlessDex/bordrless-programs/tree/main/programs/half_life',
} as const;

/**
 * Half-Life's exit fee, in parts per million, for tokens `ageSecs` old: the program's `fee_ppm`
 * (20% at 0, halved every six hours, linear within each, 0 from 48 h).
 */
export function halfLifeFeePpm(ageSecs: number): number {
  if (!(ageSecs > 0)) return HALF_LIFE.maxFeePpm;
  const halvings = Math.floor(ageSecs / HALF_LIFE.halfLifeSecs);
  if (halvings >= HALF_LIFE.zeroAfterSecs / HALF_LIFE.halfLifeSecs) return 0;
  const into = Math.floor(ageSecs) % HALF_LIFE.halfLifeSecs;
  const hi = Math.floor(HALF_LIFE.maxFeePpm / 2 ** halvings);
  const lo = Math.floor(HALF_LIFE.maxFeePpm / 2 ** (halvings + 1));
  return hi - Math.floor(((hi - lo) * into) / HALF_LIFE.halfLifeSecs);
}

/**
 * The DEX upgrade of 2026-10-08 (docs/hooks-v2.md §3.1, "The LP fee of a launch pool is
 * Bordrless's"): from this slot on mainnet a launch pool's LP fee (the sniper fee included) is
 * taken in SOL and paid to Bordrless with the protocol fee; a launch pool created before it keeps
 * its LP fee in the pool, compounding, as its traders were told. The slot is the DEX program's
 * last upgrade, read from its ProgramData account; the time is that slot's block time
 * (`getBlockTime`, unix seconds), which the backend compares a pool's `created_at` against (the
 * pools table keeps a timestamp, not a slot). Devnet and localnet were deployed after the rule:
 * every launch pool there pays Bordrless.
 */
export const LP_FEE_TO_PROTOCOL_FROM_SLOT = 454_439_142;
export const LP_FEE_TO_PROTOCOL_FROM_TIME = 1_791_434_238;

/**
 * Whether a pool's LP fee goes to Bordrless (`LaunchSummary.lpFeeToProtocol`): every launch pool's
 * (the share model), whenever it was created. The upgraded DEX keys the fee's destination on the
 * pool's fee model alone, so a launch pool opened before the upgrade compounded its LP fee until
 * that slot and pays Bordrless since. An ordinary pool's LP fee is its liquidity's. `createdAt`
 * and `cluster` are kept for the record of when the rule began (the constants above).
 */
export function lpFeeToProtocol(shareModel: boolean, _createdAt: number, _cluster: 'mainnet' | 'devnet' | 'localnet'): boolean {
  return shareModel;
}

/** The wSOL mint, which stands for native SOL on the bridge. */
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

/**
 * The signers of hook callbacks (docs/hooks-v2.md, Review fixes, note 1): the token program signs
 * every callback to a token hook with `["hook-authority", hook_program]` under the token program,
 * and the DEX every callback to a pool hook with `["hook-authority", hook_program]` under the DEX.
 * A hook accepts only its own signer, so a signer one hook receives and passes on is refused
 * everywhere else. The v1 global signers (`D7gU…`, `HoUi…`) are gone.
 */
export const HOOK_SIGNERS = {
  /** The token program's signer of the kit's callbacks (bump 254). */
  tokenForKit: 'C2Y3B3hZTesJQqLYrZ7qoaZUoRmwYWh5Qh3MuFxruouE',
  /** The token program's signer of `tax_hook`'s callbacks (bump 255). */
  tokenForTaxHook: '8v2CVajpJMVKXLpZePXQpqvq2nyn7r1so7DxgXu4CkAw',
  /** The DEX's signer of the launch's pool callbacks (bump 252). */
  dexForLaunch: '6Ztfr97cUewdViXDXdZUsQq4pz7MYdygvK1WijALjZ5q',
} as const;

/** Fixed PDAs of the programs (programs-summary §5), with the seeds each is derived from. */
export const FIXED_ADDRESSES = {
  /** `["__event_authority"]` under the token program. */
  tokenEventAuthority: '69vhpnkYjtiJgdfU7QsA5Ww7V8FWtvPcZ2r4znuyByvq',
  /** `["__event_authority"]` under the DEX. */
  swapEventAuthority: '9cBz2tsg7FwopSsd6HzvtbiL6b7B46eLG436etkB7cyx',
  /** `["config"]` under the DEX. */
  swapConfig: '2XLvgczuVACmvvjfRLLAcLwMzFHutbAAro61zZKP8fsx',
  /** `["__event_authority"]` under the bridge. */
  bridgeEventAuthority: 'EiUK62AP8DwUJWBosf7Ceyih3sGAicZxmsmcBftHzM8n',
  /** `["config"]` under the bridge. */
  bridgeConfig: 'Dwf4C8tTMYwicp8cU5MYcTtMQVVJTN7W3LcXCQ1UEhMs',
  /** `["wrapper", NATIVE_MINT]` under the bridge. */
  solWrapper: '3ta59VvLDKLnCKMhYihiC3fQ7W9jPKty6xfx3h5puHGS',
  /** `["sol-vault"]` under the bridge: the lamports behind bridged SOL. */
  solVault: 'EAcZR2i8A6BbnKRdWuyMVDTuiNkD6qc4RkFpxUYJ9Qba',
  /** `["wrapped", NATIVE_MINT]` under the bridge: bridged SOL, the quote of every launch (no hook). */
  bridgedSolMint: 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i',
  /** `["__event_authority"]` under the launchpad. */
  launchEventAuthority: '6ogQR9x8o86egutFri8ev6Kx6reTDg8YdwPmvkW29efh',
  /** `["hook-authority"]` under the launchpad: it creates launch pools and finalizes their curves. */
  launchHookAuthority: '3dfEZLdjRcpTJ4RxPzgkqnqaG2FipRdaHgRW72AL6kqL',
  /** `["config"]` under the launchpad. */
  launchConfig: '5n25iAaXFsjs4UgGQM6fCiRhaQcCVQ1L5BgyRZ7UrmaE',
  /** `["__event_authority"]` under the kit. */
  kitEventAuthority: '9abhxVTuwck5Ux79act3e2Vkfem7Q4zBwATMctUvHvuE',
  /** `["hook-authority"]` under the kit: it signs the token program's `write_hook_data` in `claim`. */
  kitHookAuthority: '2repKA1JgDkBo4AffscVee342dcBcH6c2yfpUTRrAiEN',
  /** `["__event_authority"]` under the companion program. */
  companionEventAuthority: '7QuoYRuD9MHzX5EN7qqj62iwNPVqfy74RzmwJ524cgDt',
} as const;

/**
 * The protocol lookup table (docs/hooks-v2.md §6; programs-summary §2.7): the 22 fixed addresses
 * no top-level instruction invokes, in the order the programs' tests load them and `pnpm admin
 * init` must write them (a v0 message names table entries by index). Programs a transaction
 * invokes at top level (the kit for claims and shares) are kept in the static keys by the v0
 * compiler. Per-mint accounts cannot be in it.
 */
export const PROTOCOL_LOOKUP_TABLE_ADDRESSES: readonly string[] = [
  FIXED_ADDRESSES.tokenEventAuthority,
  HOOK_SIGNERS.tokenForKit,
  FIXED_ADDRESSES.swapEventAuthority,
  HOOK_SIGNERS.dexForLaunch,
  FIXED_ADDRESSES.swapConfig,
  FIXED_ADDRESSES.bridgeEventAuthority,
  FIXED_ADDRESSES.bridgeConfig,
  FIXED_ADDRESSES.solWrapper,
  FIXED_ADDRESSES.solVault,
  FIXED_ADDRESSES.launchEventAuthority,
  FIXED_ADDRESSES.launchHookAuthority,
  FIXED_ADDRESSES.launchConfig,
  FIXED_ADDRESSES.kitEventAuthority,
  FIXED_ADDRESSES.kitHookAuthority,
  PROGRAM_IDS.kit,
  FIXED_ADDRESSES.bridgedSolMint,
  SYSTEM_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  // Appended 2026-10-08 for launches through a companion (docs/companions.md): the companion's event
  // authority and the programs it invokes, so its launch transaction fits (1,142 bytes instead of 1,266).
  FIXED_ADDRESSES.companionEventAuthority,
  PROGRAM_IDS.launch,
  PROGRAM_IDS.swap,
  PROGRAM_IDS.token,
];

/** Token hook flags (`Mint.hookFlags`). */
export const TOKEN_HOOK_FLAGS = {
  BEFORE_TRANSFER: 1 << 0,
  AFTER_TRANSFER: 1 << 1,
  BEFORE_MINT: 1 << 2,
  AFTER_MINT: 1 << 3,
  BEFORE_BURN: 1 << 4,
  AFTER_BURN: 1 << 5,
  TRANSFER_RETURNS_DELTA: 1 << 6,
  /** v2: the hook may write the 64 bytes of hook data each holding keeps. */
  WRITES_HOOK_DATA: 1 << 7,
} as const;

/** Every token hook flag (`token_flags::ALL`). */
export const TOKEN_HOOK_FLAGS_ALL = 255;

/** Pool hook flags (`Pool.hookFlags`). */
export const POOL_HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1 << 0,
  AFTER_INITIALIZE: 1 << 1,
  BEFORE_ADD_LIQUIDITY: 1 << 2,
  AFTER_ADD_LIQUIDITY: 1 << 3,
  BEFORE_REMOVE_LIQUIDITY: 1 << 4,
  AFTER_REMOVE_LIQUIDITY: 1 << 5,
  BEFORE_SWAP: 1 << 6,
  AFTER_SWAP: 1 << 7,
  /** v2: also allows the answer's `burn`. */
  BEFORE_SWAP_RETURNS_DELTA: 1 << 8,
  /** v2: also allows the answer's `burn`. */
  AFTER_SWAP_RETURNS_DELTA: 1 << 9,
  BEFORE_SWAP_OVERRIDES_FEE: 1 << 10,
} as const;

/** Every pool hook flag (`pool_flags::ALL`). */
export const POOL_HOOK_FLAGS_ALL = 2_047;

/** A launch pool's flags (`LAUNCH_HOOK_FLAGS`): before initialize, before and after swap, both deltas, the fee override: 1985. */
export const LAUNCH_POOL_HOOK_FLAGS =
  POOL_HOOK_FLAGS.BEFORE_INITIALIZE |
  POOL_HOOK_FLAGS.BEFORE_SWAP |
  POOL_HOOK_FLAGS.AFTER_SWAP |
  POOL_HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA |
  POOL_HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA |
  POOL_HOOK_FLAGS.BEFORE_SWAP_OVERRIDES_FEE;

/** Bytes of hook data every holding keeps (`HOOK_DATA_LEN`). */
export const HOOK_DATA_LEN = 64;

/** Names of the flags, for the docs and the token page. */
export function describeHookFlags(flags: number, table: Record<string, number>): string[] {
  return Object.entries(table)
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name.toLowerCase().replace(/_/g, ' '));
}
