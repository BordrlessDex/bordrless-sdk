# Changelog

The public package is `@bordrless/sdk` on npm, published from the public repository
BordrlessDex/bordrless-sdk together with `@bordrless/shared` (shared first; the SDK depends on the
same version of it). The monorepo is where both are written.

## 0.9.0 (prepared; npm has 0.8.0 until it is published)

Everything since 0.8.0 (10 Oct 2026, phase 3a). The programs it mirrors are live on mainnet; the
one exception is marked.

### Companions

- **Snowball** (`snowball.ts`, held to `vectors/snowball.json`): the market-maker companion.
  `companion.createSnowball` (after `create`, before `launch`) and `companion.snowballStep` (anyone,
  a bounty); `SnowballArgs`, `SNOWBALL_LIMITS`, `SNOWBALL_MAX_TRADE`, `snowballArgsProblem`,
  `decodeSnowball`, `snowballAddress`, `snowballMove` (which side a step would trade, off chain),
  `snowballReference`, `snowballBand`, `companionSpotPrice`, `SNOWBALL_PRICE_SCALE`;
  `Companion.snowball`. v3: separate buy and sell triggers, trades to 100% of its SOL or tokens and
  10% of the pool, intervals from 10 s, flat trades.
- **Scripts and approvals** (`scripts.ts`, held to `vectors/scripts.json`): a builder's own program
  decides what a companion's pot does. `companion.approve` and `companion.revokeApproval` (the
  protocol authority or the script approver); `companion.createScript`, `companion.scriptStep`,
  `companion.claimFeesScript`; `ScriptArgs`, `SCRIPT_LIMITS`, `APPROVAL_KINDS`, `MODE_SCRIPT`,
  `COMPANION_INIT_DISCRIMINATOR`, `COMPANION_STEP_DISCRIMINATOR`; `decodeApproval`, `decodeScript`,
  `scriptClaimAuthor`; `approvalAddress`, `scriptAddress`, `scriptStateAddress`;
  `Companion.script`. The companion's new events (`ProgramApproved`, `ApprovalRevoked`,
  `ScriptCreated`, `ScriptStepped`, `AuthorPaid`) and errors decode.
- **A custom hook beside any companion:** `LaunchKeys.customHook` is honoured by every step that
  moves the token (`devBuy`, `buyback`, `release`, `snowballStep`), which carry the hook's slice and
  its registry; `companion.snowballStep(cranker, keys, sell)` takes a sell's hook accounts
  (`client::snowball_step_with`). The launch stays from a plain config (no author share) with no
  holders' share. `CustomHookUnsupported` is no longer thrown.
- **Five-minute rounds:** `MIN_ROUND_SECS` 300, `gameRevealSecs` (a quarter of a short round, 10
  minutes from 40-minute rounds), `GAME_LIMITS.minClaimWindowSecs` 60, the streak's and strategy's
  floors (`minEpochSecs` 3,600, `minEpochClaimWindowSecs` 300); `gameArgsProblem` and
  `gameLastDraw` follow.
- The companion IDL of the 2026-10-12 upgrade (`idl/bordrless_companion.json`).

### Hooks, companions and pairs from your own terminal

- `templateHook.prepare(hook, payer, mint)`, `hookStateAddress`, `PREPARE_DISCRIMINATOR`
  (`template.ts`): the Workshop hook template's standard `prepare`, for a hook you deployed yourself.
- `buildCreateListedConfig(creator, args, authorShareBps)`: the one-call listed config, beside
  `buildCreateConfig`.
- `inspectScriptProgram(connection, program)` and `scriptProgramStatusOf`, `approvalOf`: what the
  companion program would say of a script program (deployed, immutable, approved, which lane, why
  not); `scriptNextStepAt`, `scriptDue`, `scriptInitDataBytes`.
- The README's section of that name: the exact calls for a hook, a script, a pair and for reading
  configs, companions, scripts and approvals, on the Workshop lane and the self-serve lane.
- Doc strings and the README corrected: the Workshop (not Studio) deploys under Bordrless's key;
  a custom hook runs beside a companion; the lottery hook's audited status; the five-minute rounds.

### Integrators

- **Balances** (`balances.ts`): `tokenBalanceChanges(tx, { connection })` answers SPL-shaped
  `preTokenBalances` and `postTokenBalances` for Bordrless holdings from the token program's events;
  `holdingBalanceChanges`, `transactionTokenEvents`, `mintDecimalsReader`, `uiAmountString`,
  `MissingDecimalsError`. Decimals are read, never guessed.
- **`bordrless mm`** (`cli/mm.ts`, `cli/mmRun.ts`): a self-custodied market maker on a token's
  pool, run with your own key (`--dry-run`, `--once`, thresholds, caps, slippage).
- **Risk labels:** a hook's callees (the programs its registry names) lower its label
  (`hookRiskLabel` with `opts.mint`); a mint's own authorities as a label (`mintRiskOf`,
  `MintRiskLabel`).

### `@bordrless/shared` 0.9.0

- The Workshop (`workshop.ts`): `WorkshopItem`, `WorkshopDetail`, `WorkshopFee`, the deploy quote,
  the config requests, and pairs (`kind: 'pair'`, `scriptFiles`, `scriptProgram`, `scriptDeployed`,
  `approvedScriptHash`, `scriptApproved`).
- The API (`api.ts`): `ScriptRequest` and `ScriptSummary` (with `reviewed`, `reading`, `verdict`),
  `SnowballRequest`, `SnowballSummary`, `CompanionRequest.script` and `.snowball`,
  `ConfigInspection.requiredCompanion` (`RequiredCompanion`) and `.hook` (`HookReading`, Bordrless's
  reading of a Workshop hook), `HookRiskStatus`, `LaunchSummary.companionTag`, the `RuleFilter`
  values of the hook catalog.
- The policy (`policy.ts`): `SCRIPT_BOUNDS`, `SCRIPT_INTERVAL_CHOICES_SECS`, `scriptProblem`,
  `scriptRequestOf`, `scriptInitDataLength`; `SNOWBALL_BOUNDS`, `SNOWBALL_PRESETS`,
  `snowballProblem`, `snowballRequestOf`; `LOTTERY_LIMITS` and `LOTTERY_DEFAULTS` for 15-minute
  rounds and a minute's claim window; the pool fee tiers; `StudioKind` `'script'`,
  `StudioVerifyRequest`/`StudioVerifyResponse`.

### Coming (not in 0.9.0)

- The payout answer (docs/loss-cover.md §1): a script's `companion_step` answering a
  `PayoutAnswer` the companion pays from the pot. Its encoder lands in `scripts.ts`,
  `companion.createScriptV2` and `decodePayoutTerms` in `companion.ts`, with `vectors/payouts.json`.
- The self-serve script lane (an immutable script with no approval) runs once the companion upgrade
  of 2026-10-12 evening is live on mainnet; the SDK already reads it (`inspectScriptProgram`).

## 0.8.0 (10 Oct 2026)

Phase 3a: timelocked hooks (`authority.ts`, `timelock.ts`, the `bordrless hook` and `bordrless
strategy` CLI), risk labels (`risk.ts`), Studio attestations, strategy games, the hook vault.
