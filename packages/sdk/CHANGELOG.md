# Changelog

The public package is `@bordrless/sdk` on npm, published from the public repository
BordrlessDex/bordrless-sdk together with `@bordrless/shared` (shared first; the SDK depends on the
same version of it). The monorepo is where both are written.

## 0.10.0 (13 Oct 2026)

Everything since 0.9.0. The programs it mirrors are live on mainnet: the rules engine (`rules_hook`,
`RULES_HOOK_PROGRAM`), the launchpad's SOL cut, the companion's payees and wallet payouts (verified
build `708a6083…` of bordrless-programs `212f6ba`), and the router (`7M5GTuzh…`, verified build
`f6718c16…`).

### The router: an integrator fee on any swap

- `router.swap(trader, integratorQuote, treasuryQuote, dexSwap, feeBps, minQuoteAfterFee)` wraps any
  DEX swap (`launch.swap`, `swap.swap`) with an app's fee: at most 1% (`ROUTER_MAX_FEE_BPS`) of the
  trade's quote side, a buy's from its input before the swap, a sell's from what it delivered; 20%
  of it (`ROUTER_BORDRLESS_SHARE_BPS`) to the DEX treasury's holding (`routerTreasuryQuote`), the
  rest to the integrator's. `routerFeeSplit` computes it as the program does. `ROUTER_PROGRAM`, the
  router's IDL and errors. bordrless-programs `docs/router.md`.

### Companions: payees and wallet payouts

- **Payees:** `companion.setPayees(payer, mint, [{ wallet, bps }])` before the launch (the mint
  signs): up to 10 wallets (`MAX_PAYEES`) share the beneficiary part, each its basis points of it;
  the beneficiary keeps the rest. `companion.withdrawWithPayees(sender, mint, beneficiary, wallets)`
  pays them (`Companion.payees` says a companion has them); a payee that can't take its part yet is
  owed it. `payeesAddress`, `decodePayees` (with `beneficiaryOwed`), `COMPANION_VERSION_WITH_PAYEES`.
- **Wallet payouts:** `companion.allowWalletPayouts(mint)` before the launch lets a script with
  payout terms (`createScriptV2`) pay any wallet SOL within them: its answer is
  `encodeWalletPayoutAnswer([{ to, lamports, tag }])` (version `WALLET_PAYOUT_ANSWER_VERSION`, each
  wallet passed writable). `decodePayoutTerms(...).walletsAllowed`, `decodeWalletPayoutAnswer`,
  `decodeScriptAnswer` (by version).
- The companion IDL of 13 Oct: `set_payees`, `allow_wallet_payouts`, the `Payees` account, the events
  `PayeesSet`, `PayeePaid`, `ScriptWalletPayout`, `WalletPayoutsAllowed`, errors 6087 to 6090.

### Compose a hook: rules, no program

- **The builder** (`rules.ts`, held to `vectors/rules.json` in @bordrless/shared, which the engine's
  own tests read): `rules.compose({ keeps, destination, entryCapBps }).rule({ on, when, unless,
  then, stop }).build()` throws the engine's own refusal by code (`RulesError`); the values
  (`rules.gain.gt(0)`, `rules.sinceReceived.lt(3600)`, ...), the actions (`rules.cut`,
  `rules.refuse`, `rules.count`, `rules.mark`), and the shared coders and words (`rules.encode`,
  `rules.decode`, `rules.validate`, `rules.render`, `rules.flagsFor`, `rules.reading`).
- **The engine's two instructions**, hand-encoded until its IDL exists, their wire format in one
  block to check against it: `rulesHook.bind` (`bindData`, `bindKeys`, `BIND_DISCRIMINATOR`) and
  `rulesHook.prepare` (`prepareData`, `prepareKeys`: the template's five accounts and the config's
  `RuleSet`, read-only). `buildCreateComposedConfig`: `create_config` (or `create_listed_config`)
  naming the engine with the set's flags, and `bind`, in one transaction.
- **Reading what is there:** `ruleSetAddress`, `rulesStateAddress`, `decodeRuleSetAccount`,
  `decodeRulesState`, `decodeRulesHolding` (the holding's 64 bytes, the Loss cover script's fields
  at the same offsets), `rulesDestinationHolding`, `RULE_SET_LAYOUT`, `RULES_STATE_LAYOUT`,
  `RULES_HOLDING_LAYOUT`.
- **Listing it** (`workshop.ts`): `workshop.signIn(wallet, signMessage)` signs the Workshop's
  sign-in message (a message, never a transaction) and answers the session;
  `workshop.registerComposed(config, session)` lists a listed composed config on the Workshop's
  shelves (`POST /v1/workshop/register`: no checks, no fee, six a day); `BORDRLESS_API`,
  `WorkshopApiError` (the API's status and code).
- **The escape hatch:** `rules.toStarter(set)` writes the Workshop template's `src/lib.rs` with the
  same rules spelled out in Rust, for what the lane cannot say.

### In @bordrless/shared

- `rules.ts`: the language, `encodeRules` / `decodeRules`, `validateRules` (`RULES_ERROR_TEXT`),
  `renderRules`, `rulesFlagsOf`, `rulesHookReading`, `rulesReadingWords`, `RULES_LIMITS`; the
  engine's refusals by reason (`RULES_REFUSAL_ERRORS`, `RULES_REFUSAL_CODES`, `RULES_REFUSAL_TEXT`,
  `refuseReasonOfError`, `refuseReasonOfCode`) and the line a refused trade says from the token's
  own rules (`rulesRefusalLine`).
- `HookReading.lane` and `.verdict` take `rules`; `WorkshopLane` takes `rules`; a composed hook's
  set travels as `CustomHookInfo.rules` and `LaunchConfigData.customHook.rules` (`RulesReadout`).
- `RULES_HOOK`, `RULES_HOOK_PROGRAM` (a placeholder until the engine is deployed).

### The launchpad: a custom hook's SOL cut (live on mainnet)

- **A custom hook's SOL cut** (launchpad upgrade of 13 Oct 2026, bordrless-programs `22932e5`,
  `docs/quote-cut.md`): a launch config whose custom hook also takes SOL on every trade. The
  launchpad asks the hook's `quote_cut`, caps its answer (at most 10% a side) and takes it with the
  creator fee. `launch.createQuoteCutConfig`; `Launch.quoteCut` / `quoteCutAccrued` and
  `LaunchConfigAccount.quoteCut` (`quoteCutCapsOf`, `QUOTE_CUT_MAX_BPS`); `quoteCutExtras`,
  `quoteCutSignerAddress`, `quoteCutStateAddress`, `launchPoolRegistryListWithQuoteCut`.
  `launchKeysOf` + `launch.swap` add the four accounts for the trader on such a coin (none for the
  creator trading to itself); without them a trade fails with `QuoteCutAccountsMissing`. The launch
  IDL gains `create_quote_cut_config`, the events `QuoteCutConfigured`, `LaunchQuoteCut` and
  `QuoteCutTaken` (logged, not self-CPI) and the errors 6046 to 6049.

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
