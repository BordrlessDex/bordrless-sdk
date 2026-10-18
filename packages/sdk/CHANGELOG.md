# Changelog

The public package is `@bordrless/sdk` on npm, published from the public repository
BordrlessDex/bordrless-sdk together with `@bordrless/shared` (shared first; the SDK depends on the
same version of it). The monorepo is where both are written.

## 0.17.0 (18 Oct 2026; on GitHub, not yet on npm)

- **Agent companions (18 Oct 2026, docs/agents.md; monorepo `bdef1a9`…`6bbe37b`).** shared: `agent.ts` (`AGENT_FILE`, `AGENT_LIMITS`, `AGENT_STATE_FIELDS`/`AGENT_STATE_WORDS`, `parseAgentDeclaration`, `agentDeclarationOf`, `agentOfFiles`, `canonicalAgentJson`, `agentWords`, `agentDetails`, `encodeAgentDecision`/`decodeAgentDecision`/`agentDecisionSeqOf`, the `evolve` field), `AGENT_KEY` and `TREASURY` in `programs.ts`, `WorkshopItem.agent`, `ScriptSummary.agent`, `AgentLog`/`AgentDecisionEntry` in `api.ts`. sdk: `agent.ts` (`checkAgentJson`, `agentJson`, `AGENT_EXAMPLE`, `AGENT_SIGNER`, `DECIDE_DISCRIMINATOR`, `encodeDecideArgs`, `decideInstruction`, `scriptStateAddress`, `decisionOfArgs`). The script starter (`tools/studio-builder/template-script/src/lib.rs`) is agent-ready (`decide`, `read_decision`, `clear_decision`, `pay_bill`, `STATE_LEN` 105); the public API has `GET /v1/agent/:mint`.
- **Hook rates from one answer (monorepo `cfe541a`).** shared `rates.ts`: what a Workshop hook takes of a buy and of a sell, from the reading's rules and the SOL cut's caps (one answer for every page).
- **Script starter public.** `starters/script/` in this repository is the Workshop's companion script starter (`tools/studio-builder/template-script` in the monorepo), with `decide` for agent companions.

## 0.16.0 (17 Oct 2026; on GitHub, not yet on npm; includes everything of the unpublished 0.15.0)

Everything since the published 0.14.0 (npm `latest` for both packages, 15 Oct 2026 ~18:00 UTC),
the 0.14.1 items below included. A changed constant and new exports, so a minor version. What an
integrator on npm 0.14.0 gets wrong today: `checkLaunchRules` caps a launch's fee at 2%
(`MAX_CREATOR_FEE_BPS` 200, `RULE_BOUNDS.maxRulesFeeBps` 300) where the site and the API take 5%,
and `parseKeeperDeclaration` / `checkKeeperJson` refuse a keeper.json with `launcherShareBps`,
`payoutTerms` or `mintWritable` ("the file has no field ...") that the Workshop takes.

### Fee helpers and readers (shared and SDK)

- shared `fees.ts`, re-exported by the SDK: `feeSplitOf` (creator fee + companion fee to
  `creatorFeeBps` and the split, rounded as the launch form), `feesOfSplit` (back),
  `launcherShareOfFees`, `scriptAuthorShare` and `claimBeneficiaryPart` (the companion's author
  share after bordrless-programs `b91b673`: half of the launcher's part of the fee taken, capped at
  the claim's beneficiary part), `SCRIPT_AUTHOR_SHARE_BPS`, types `LaunchFees`, `CompanionFeeParts`.
- shared `SCRIPT_PAYOUT_OPEN` (the open payout terms, moved from the site).
- SDK `launchFeesOf(launch, companion)`, `pairLauncherShareBps(inspection)`, `SCRIPT_APPROVER`.
- SDK re-exports `keeperLaunchTerms`, `withLauncherShare`, `PAIR_DEFAULT_LAUNCHER_SHARE_BPS`,
  `KEEPER_MAX_LAUNCHER_SHARE_BPS`, type `KeeperLaunchTerms`.
- `explainProgramError`: a plain message for the companion's `NotTermsAuthority` (6094).
- Workshop script template: vendored `bordrless-core` `MAX_CREATOR_FEE_BPS` 200 to 500 (as
  `policy.ts`); its starter says how keeper.json `mintWritable` lets a script burn.

### The companion upgrades of 15 Oct 2026 (live on mainnet)

- **Payout terms after launch** (bordrless-programs `abfc783`): `set_payout_terms`, signed by the
  launch's beneficiary (the launcher) or the script approver (`NotTermsAuthority`, 6094, otherwise),
  replaces a script's payout terms within `create_script_v2`'s bounds; the window starts over and
  the paid counters and the wallet-payouts flag are kept. `PayoutTermsSet` is emitted by both
  `create_script_v2` and `set_payout_terms`. A window's cap is now `windowBps` of `max(windowPot,
  potAfterScript + windowPaid)`, less `windowPaid`: fees arriving mid-window count, and it is never
  below the old frozen cap.
- **The author's share from the launcher's part only** (bordrless-programs `b91b673`, deployed 15
  Oct 23:34 UTC): a script companion's claim pays the script's author `AUTHOR_SHARE_BPS` (half) of
  the launcher's part of the creator fee the claim took (after the hook's SOL cut), out of that
  part: never of the pot (the companion fee), the buyback, the holders or the hook's cut. Before it
  the author was paid half of the whole claim, first. The bounty is taken from the whole claim;
  `FeesClaimed.toBeneficiary` is net of the author's share, and `FeesClaimed.claimed` counts the
  claim less it. The companion IDL's instructions, accounts and fields are unchanged by it.

### In the SDK

- **`kit.claimSolFor(payer, owner, mint)`** (bordrless-programs `kit-claim-sol-for`; the kit IDL with
  `claim_sol_for`): a native kit's `claim_sol` pushed by anyone, `payer` signing and paying the fee,
  `owner` writable and not signing, paid to the holding's owner with `claim_sol`'s checks
  (`NotAHolder`, `NothingToClaim`, `RecipientBelowRent`). Bordrless's keeper uses it to pay holders.
  `KitConfig.creatorIsCompanion` is decoded, and `kitExcludes` excludes a companion creator as the
  kit does (it had only the pool and the launch).
- From 0.14.1 (committed in the public repo, never published): `companion.setPayoutTerms(authority,
  mint, { stepBps, holdingBps, windowBps, windowSecs })`; `payoutStepBudget` measures the window
  against the live pot as above; the companion IDL with `set_payout_terms` and `NotTermsAuthority`
  (6094).
- Doc strings and the README: the creator fee (the launcher's part) and the companion fee (the
  pot's part) of one on-chain fee, the site's 5% cap beside the launchpad's 10% (the launch form's rows 0 to 2% each, a
  Workshop config's fee any quarter percent), a
  pair's split fixed by its builder (`split_fixed`); the builders' shares (a hook's 0 to 50% of the
  creator fee in 5% steps; a script's or a pair's half of the launcher's part, or nothing); payout
  terms (keeper.json `payoutTerms`, the open terms a Workshop script launches with otherwise,
  `setPayoutTerms`); keeper.json `mintWritable`; a native coin's keeper.json pays `owner`, not
  `ownerQuoteHolding`; the companion PDA `["creator", mint]` named the companion address throughout.

### In @bordrless/shared

- `RewardPosition.autoPaid` (optional; true when the API's keeper pushes the position's rewards
  to the wallet: a native kit, with the push on).
- **The fee cap is 5%** (the owner, 15 Oct 2026): `MAX_CREATOR_FEE_BPS` 200 → 500 and
  `RULE_BOUNDS.maxRulesFeeBps` 300 → 500, the whole of each trade's fee (the creator fee and the
  companion fee together); the launchpad's own cap (`Config.max_creator_fee_bps`) is 10%.
  `FEE_STEP_BPS` (25: quarter-percent steps), `workshopConfigFeeOk`, `WORKSHOP_CONFIG_FEE_WORDS`.
- **A pair's split**: `KEEPER_MAX_LAUNCHER_SHARE_BPS` (9,500: the pot keeps at least a twentieth),
  `PAIR_DEFAULT_LAUNCHER_SHARE_BPS` (5,000, even until its builder sets it), `withLauncherShare`.
- **Builder shares**: `WORKSHOP_AUTHOR_SHARE_STEP_BPS` (500) and `workshopAuthorShareOk(bps, kind)`
  (a hook's any 5% step from 0 to half; a companion's or a pair's half or nothing).
- **keeper.json** (version 1, all optional, left out of the normal form when absent or false, so a
  declaration approved before hashes as it did): `launcherShareBps` (0 to 9,500 of the fee, the
  launcher's, fixed for every launch), `payoutTerms` (`{ stepBps, holdingBps, windowBps, windowSecs }`
  within the companion's bounds) and `mintWritable` (every step passes the coin's mint writable, so
  a script can burn what it bought). `parseKeeperDeclaration` and `checkKeeperJson` take them;
  `keeperLaunchTerms` carries `launcherShareBps` and `payoutTerms` (`KeeperLaunchTerms`);
  `keeperDetails` says all three.
- **Native-ready scripts**: `scriptNativeReady(files, keeper)`, `SCRIPT_NOT_NATIVE_REFUSAL`,
  `NATIVE_NOT_READY_TEXT`; `WorkshopItem.nativeReady` and the pair's
  `ConfigInspection.requiredCompanion.nativeReady`.
- `HOOK_QUOTE_CUT_FLOOR_BPS` (1: a SOL cut's buy cap is above 0).
- **Workshop API types**: `WorkshopSubmitRequest.creatorFeeBps` and `.launcherShareBps`,
  `WorkshopConfigPrepareRequest.launcherShareBps`, `WorkshopItem.plannedFeeBps`, `.image`,
  `.archived`, `.archivedAt`; `WorkshopArchiveRequest`, `WorkshopArchived`; `WorkshopCoin`,
  `WorkshopCoinsResponse`, `WorkshopCoinsSort`, `WORKSHOP_COINS`; `WORKSHOP_IMAGE`; the reading's
  card (`WorkshopReading.summary`: `WorkshopSummary`, `WorkshopSplitPart`, `WorkshopPurpose`,
  `WORKSHOP_PURPOSES`, `WORKSHOP_PURPOSE_WORDS`).
- **keeper.json `view` (16 Oct 2026)**: up to 6 figures a coin's page shows live from the script's
  accounts (`KeeperViewField`: a label of up to 24 characters; `account` `"script"`, the script's own
  state, or `{ "hook": [seeds] }`, an account of the coin's custom hook at the address those seeds
  give under its program, `"mint"` standing for the coin's mint; the bytes' `offset` and `width`,
  1, 2, 4 or 8, or 32 for a wallet; and `as`: `number`, `lamports`, `tokens`, `bps`, `time`, `secs`,
  `wallet` or `flag`; `KEEPER_VIEW_AS`, `KEEPER_LIMITS.view`, `.viewLabel`, `.viewSeeds`,
  `.viewSeedBytes`). Served raw as `ScriptSummary.view` (`ScriptViewFigure`) on the coin's companion
  status; left out of the normal form when empty.
- **keeper.json `pools` (17 Oct 2026)**: up to 3 plain DEX pools each step brings beside the launch
  pool (`KeeperPool`: `base` and `quote` `"coin"`, `"sol"` (only as a quote) or a mint's address;
  `feeBps` the pool's LP fee in basis points, any whole number the DEX takes, 0 to
  `KEEPER_MAX_POOL_FEE_BPS` (9,000), 25 when absent, part of its address; `liquidity`
  brings its LP mint and LP holdings too; `KeeperPoolMint`, `KEEPER_LIMITS.pools`). Never the coin's
  own launch pool, never the same pool twice; `keeperDetails` says each. Bordrless's keeper then
  brings, after the swap accounts, each pool's classic-swap accounts for the companion address, the
  system and swap programs, each mint's token hook accounts, and with liquidity the LP mint and the
  LP holdings of the launch (the locked one) and of the companion address, and makes the coin an
  address lookup table of its own so the step fits one transaction (docs/scripts.md).
- `WorkshopReading.byHand` (optional, 17 Oct 2026): a reading an operator wrote and stored through
  `POST /admin/workshop/:id/reading` while the model could not run; the model's readings never set it.
- **Checks held back, said (17 Oct 2026)**: `WorkshopDetail.checksResumeAt` (optional, unix seconds): when an item's checks go on while a wait holds them (a wallet's builds of the day used up); `WorkshopReading.byHand` (optional): a reading an operator wrote through `POST /admin/workshop/:id/reading`.
- **Deploy cost on the item (16 Oct 2026)**: `WorkshopDetail.deployCost` (optional; `WorkshopDeployCost`): what deploying its approved build will cost at today's rent, a pair's both halves, null once deployed, so a builder funds the wallet before the quote.
- **The Workshop rework (16 Oct 2026)**: `WorkshopItem.configFeeBps` (its launch config's creator
  fee as the chain holds it; null without a config), `WorkshopDetail.notesImage` (an image under the
  builder's words), `pairFeeParts(totalBps, launcherShareBps)` (a pair's fee as the launcher's
  creator fee, its share rounded to the nearest bp, and the companion fee, the rest),
  `WORKSHOP_READING_LIMITS.titleMax` (80: the most a reading's title is kept whole at), and in the
  API `POST /v1/workshop/:id/notes/image` and `POST /v1/workshop/:id/notes/image/clear` (the image
  under the builder's words, set and removed). `RewardPosition.autoPaid` (optional; true when the
  API's keeper pays the position's holder rewards to the wallet by itself: a native kit, with the
  push on; read as false when absent).
- Words: `scriptProblem` says the fee as the whole ("The script’s part and the rest of the fee must
  add up to 100%.", "There is no creator fee or companion fee for the script to spend: set a
  companion fee."); keeper.json's
  `launcherShareBps` refusal says the pot gets at least a twentieth.

## 0.14.1: payout terms after launch (committed in the public repo, never published; folded into the next release)

For the companion upgrade of 15 Oct 2026 (bordrless-programs `abfc783`, deployed).

- `companion.setPayoutTerms(authority, mint, { stepBps, holdingBps, windowBps, windowSecs })`:
  `set_payout_terms`, a script companion's payout terms replaced after launch, signed by its
  beneficiary or the script approver. The window starts over; emits `PayoutTermsSet`.
- `payoutStepBudget` measures the window as the program now does: `windowBps` of
  `max(windowPot, potAfterScript + windowPaid)`, less `windowPaid`, so fees arriving mid-window can
  be paid in it. Never less than before; a script computing the old cap still answers within it.
- The companion IDL carries the instruction and `NotTermsAuthority` (6094).

## 0.14.0: native SOL (published 15 Oct 2026)

The off-chain side of moving Bordrless from bridged SOL (`A49oVh…`) to native SOL (bordrless-programs
`4591354`, the native-sol merge, deployed to mainnet 15 Oct 2026; `docs/native-sol-migration.md`).
Every export of 0.12.0 keeps its name and signature, and its behaviour on bridged pools and
launches, with **one breaking change on native launches**:

- **Breaking: `launch.swap` builds `swap_v2` for a native launch** (`LaunchKeys.native`, which
  `launchKeysOf` sets from a native `Launch`). The trader's wallet pays a buy in SOL and a sell
  delivers SOL to the recipient's wallet; no wrap or unwrap. This is deliberate: it is what a native
  launch should trade. Code that wraps SOL before `launch.swap` now leaves that bridged SOL unspent
  (no loss), and `router.swap(…, launch.swap(…))` throws for a native launch: use `router.swapV2`.
  **Escape hatch:** `launch.swapClassic` builds the classic `swap` with bridged SOL in holdings
  whatever the launch's form. `docs/native-sol-integrators.md` (`docs/integration/04-trading.md` in
  the public repo) has the detail.

Held coins (a companion whose Workshop script is not native-ready: its pool native, the rest bridged):
`swap.bufferAll` (the DEX's `buffer_all`, sent before a held coin's step with `rebalance_pool` after
it) and `POOL_QUOTE_FORM_KIND.bufferedAll`; `NATIVE_SCRIPT_HOLD` and `nativeScriptHold` in
`@bordrless/shared`.

After the native-SOL audit (bordrless-programs `docs/native-sol-audit.md`):

- `launch.swapV2` passes the bridge's accounts by default only when the launch is not native
  (`!keys.native`: a held or half-migrated coin), so native trades no longer write-lock the
  bridge's global SOL accounts (O-1). `withBridge` still overrides.
- `swap.swap` (classic) and the liquidity builders pass the trader / provider writable: on a native
  pool what the buffer can't cover of an old-path sell or a withdrawal is paid to it in SOL.
- `swap.migratePoolToNative(admin, pool, target, allowForeignHook = false)` (the DEX refuses a
  foreign hook without it, and pool `4PvPnTBy…` always); `swap.revertPoolToBridged(admin, pool,
  launchMint)` passes a launch pool's launch (the DEX refuses while it is native);
  `launch.revertLaunchToBridged` passes the coin's hook-vault and companion addresses (refused while
  either is native); `companion.launchScript` (a script companion's launch, which a script that is
  not native-ready can't do while native launches are on).
- `explainProgramError` knows `ForeignHookPool`, `ExcludedPool`, `LaunchStillNative`,
  `CompanionStillNative`, `VaultStillNative` and `ScriptNotNativeReady`; `RESERVED_ACCOUNT_KEYS` in
  `@bordrless/shared` (keys that can't be a partner).
- The market maker (`bordrless mm`) trades native markets in plain SOL: no wrap, `swap_v2`, sells
  measured in lamports.

After the re-audit (bordrless-programs `docs/native-sol-reaudit.md`):

- The DEX pays an old-path sell's or withdrawal's shortfall as SOL only to a top-level swap by the
  delivery holding's owner (R-1); a CPI caller (the router's old `swap`) or a delegate gets
  `BufferShort`, as before the fallback.
- `launchKeysOf(launch, hook, { poolNative })` and `LaunchKeys.poolNative`: `launch.swap` builds
  `swap_v2` with the bridge's accounts for a held or half-migrated coin (pool native, launch
  bridged), whose classic sells fail at buffer target 0 (R-3). The market maker passes it.
- `MAX_SCRIPT_LAUNCH_HOOK_EXTRAS` (3): the registry extras a script companion's launch fits with
  the script's address appended (R-5).

- **IDLs**: the DEX, the launchpad, the kit, the companion, the router and `hook_vault` with their
  native-SOL instructions, events and errors (`BufferShort`, `LamportsShort`, `NotNativePool`, …,
  explained in `explainProgramError`).
- **Flags**: `Pool.quoteNative`, `bufferQuote`, `bufferTarget` (`reserved[0..17]`),
  `LaunchConfig.nativeLaunches`, `Launch.isNative` (`reserved[17]`), `KitConfig.isNative` and
  `lamportsBase`, `Vault.isNative`, `Companion.nativeSol` (`decodeCompanion` reads 300, 308 and
  309-byte companions; `COMPANION_LEN_NATIVE`). All optional fields, absent from objects older code
  made.
- **Rent at the cluster's rate**: `loadRent(connection)` reads the Rent sysvar (`rentOfSysvar`, `setRent`) and every reader of
  SOL above rent (`rentExemptMinimum`, `lamportsAboveRent`, the native balance readers) uses it. Mainnet's rent is 5,080
  lamports a byte (SIMD-0437, lower steps to come), not the legacy 6,960 the readers assumed, which under-counted every native
  launch's, companion's and vault slot's SOL; until `loadRent` they keep the legacy rate. `RENT_EXEMPT_EMPTY` is deprecated
  (the legacy 890,880): use `rentExemptMinimum(0)`.
- **Launchpad IDL**: `migrate_launch_to_native` and `revert_launch_to_bridged` take `reward_vault` read-only (the kit's id
  for a kit without holder rewards).
- **Builders**: `swap.swapV2`, `swapV2WithHooks`, `swapFor` (by the pool's form),
  `createNativePool`, `migratePoolToNative`, `revertPoolToBridged`, `rebalancePool`,
  `setBufferTarget`; `launch.swapV2`, `swapClassic`, `claimCreatorFeesSol`, `claimAuthorFeesSol`,
  `distributeFeesSol`, `claimCreatorFeesFor`, `setNativeLaunches`, `migrateLaunchToNative`,
  `revertLaunchToBridged`; `kit.claimSol`, `shareSol`, `claimFor`, `setNative`;
  `companion.nativeAccounts`, `native`, `migrateToNative`, `revertToBridged`;
  `vault.setVaultNative` (and `execute`/`executeBuy` add the `swap_v2` accounts for a native
  vault); `router.swapV2`. Every one is held byte for byte to the Rust clients
  (`vectors/native-sol.json`).
- **`launch.swap` picks the path** (the breaking change above): with `LaunchKeys.native` it builds
  `swap_v2`; without it, exactly the classic `swap` as before (`launch.swapClassic` builds that one
  whatever the keys). `swap.swap` stays the raw `swap` instruction; `swap.swapFor(pool, …)` picks.
- **Events**: `typedNativeEvent` reads `SwappedNative`, `PoolQuoteFormChanged`, `LaunchNativeSet`,
  `NativeLaunchesSet`, `KitNativeSet` and `CompanionNativeSet`; `pairSwappedNative` and
  `swapSolSide` read a `swap_v2`'s SOL side (its `Swapped` deltas and recipient may be wallets);
  `launchSwapCutsOf` finds a launch's fees wherever it keeps them. `typedEvent` and `TypedEvent`
  are unchanged.
- **Balances** (`native.ts`): `poolQuoteBooks`, `poolLamportsQuote`, `poolBufferDrift`,
  `classicSellCapacity`, `poolQuoteStateOf`/`fetchPoolQuoteState`, `spendableQuote`,
  `launchCreatorFeesOf`/`fetchLaunchCreatorFees`, `kitRewardVaultOf`/`fetchKitRewardVault`,
  `companionSolOf`/`fetchCompanionSol`, `vaultSlotSolOf`/`fetchVaultSlotsSol`,
  `rentExemptMinimum`, `NATIVE_POOL_FILTERS`.

## 0.13.0 (15 Oct 2026)

- The companion's fee claim tells the hook's SOL cut apart (companion upgraded on mainnet 15 Oct):
  `FeesClaimed.fromHook` (appended; an event from before decodes with `fromHook: '0'`) and
  `Companion.quoteCutClaimed` (the account grows from 300 to 308 bytes; `decodeCompanion` reads a
  300-byte companion with `quoteCutClaimed: null`). `COMPANION_LEN`, `COMPANION_LEN_V1`,
  `padOldEvent`.

## 0.12.0 (14 Oct 2026)

Everything since 0.11.0. The DEX and the launchpad of the curve fill are live on mainnet (verified
builds `98ae8d06…` and `ec650216…` of bordrless-programs `99b5ed6`). After the audit, a fill is
taken only for a swap the transaction sends the DEX itself, and only on a launch pool's curve: a
program that calls the DEX (the router, a companion, your own) and a curve another program opens
behave exactly as before, failing past the end with `InsufficientLiquidity`.

What changed for builders on 13 Oct 2026 after 0.10.0 was written up. Every type and constant
below is `@bordrless/shared`'s unless said otherwise; the README's walkthrough was rewritten to
match (below).

- **A buy past the end of the curve is filled** (the DEX and launchpad upgrade of 13 Oct 2026,
  docs/hooks-v2.md §3.1, §5.4). A buy larger than what a launch's curve has left no longer fails
  with `InsufficientLiquidity`: the launchpad's `before_swap` answers the fill, the smallest part
  of the input that sells the curve out, the DEX uses that much (its fees of that part), takes
  every token left and leaves the rest of the input in the trader's quote holding, and `graduate`
  can follow in the same transaction. `curveFillBuy(reserves, amountIn, lpFeeBps,
  protocolShareBps, params, quoteCutBps?)` is the program's bisection (null short of the end);
  `quoteLaunchSwap(…, fill)` is the swap of the fill; `launchBuyNetIn` and `quoteCutFee` are the
  pieces. `SwapQuote.amountUsed` (`swap/quote`, `swap/prepare`) says the part used, the figures
  being of it, and `minAmountOut` is for the whole `amountIn` at the fill's rate: the program
  holds a filled buy's minimum to pro rata, so a terminal gives the least it accepts for the
  whole input. The site's prepared transaction wraps the whole amount and unwraps what was not
  used back to SOL. The pool hook protocol (`bordrless-hook`, declared last so no other hook's
  build moves): `answer_bytes` / `set_answer` / `read_filled_answer`, nine bytes after a
  `before_swap` answer, taken by the DEX where the pool's flags let the hook cut the input
  (`BEFORE_SWAP_RETURNS_DELTA`); a plain answer is byte for byte what it was, so a hook built
  before needs no change. The DEX's new error `BadFill` (`swap`, 6038): a fill of zero, above the
  input, for a sell or on a pool that is not a curve.

- **One reading, automatic approval.** The Workshop's separate security review by AI is gone: the
  reading (`WorkshopReading`) is the one AI pass and carries a `verdict` and `findings`;
  `WorkshopCheck.id` `review` is no longer sent. An item is approved by itself once the template's
  rules, the build and a hook's trading test pass (`WorkshopDetail.approvedBy` `'auto'`); the
  verdict and findings are shown with it and never hold it.
- **The reading's rules.** `WorkshopReading.rules` (`WorkshopReadingRule`: `on`, `when`, `bps`,
  `to`, `text`; `WORKSHOP_RULE_ON`, `WORKSHOP_RULE_TO`, `WORKSHOP_RULE_ON_WORDS`,
  `WORKSHOP_READING_LIMITS.rules`), the exact rows the site shows for a custom hook ("Under 5M
  tokens: 0% hook tax", "Every 5 minutes: the pot pays holders under 20M tokens"), and
  `measuredBps`, the trading test's largest cut the reading was held to (a reading that said less
  is written again). `WorkshopFigures` (`WorkshopDetail.figures`): SOL and tokens its hook took,
  the pot's in and out, the holders paid.
- **keeper.json `stepSecs`.** How often a script's step runs is the builder's, in the declaration
  (`KeeperDeclaration.stepSecs`, 10 s to a day; without it a thirtieth of a fixed `roundSecs`, else
  a minute: `keeperStepSecs`, `DEFAULT_STEP_SECS`, `STEPS_PER_ROUND`). `keeperLaunchTerms` and
  `KeeperLaunchTerms` (`stepSecs`, `wallets`) are what a launch takes from it, served on
  `WorkshopItem.keeper`; the launch page asks the launcher for nothing.
- **hook.json's trading test.** The builder worker runs a hook's SOL cut at its declared caps:
  `StudioSim.quoteCut` (`StudioSimQuoteCut`: the most taken of a buy and of a sell, the hook's
  largest answer, the trades asked and taken, the SOL taken) on `WorkshopDetail.test.quoteCut`; a
  cut that is not min(answer, cap) of the SOL the launchpad passed fails the test.
- **The builder's share.** `WorkshopSubmitRequest.authorShareBps`, `WorkshopItem.authorShareBps`,
  `WorkshopConfigPrepareRequest.authorShareBps`, `WORKSHOP_AUTHOR_SHARES_BPS` (`AUTHOR_SHARE_BPS` or
  0): a builder takes half the creator fee of others' launches or nothing, chosen at the submission
  (a hook's again at its config step). A pair's config pays no author; its builder is paid by the
  companion program.
- **Adopted configs.** A listed config a hook's builder made with the SDK (`buildCreateListedConfig`)
  and launched with is adopted by the Workshop as the item's `config`, so the hook is offered on the
  launch page; every launch made with the hook counts on the item, by its program.
- **Pairs, as the owner put it:** a hook on the trades and a companion on the pot, as one; the hook
  can take a cut, keep a score or fund the pot, the companion pays from the pot, filled by the
  creator fee or by the hook (Whale Bait). A pair's fix sends both halves in one drop.
- **Compose a hook is off the site** (the owner, 2026-10-13). `rules.ts`, `buildCreateComposedConfig`
  and `workshop.registerComposed` stay in the package for the deployed engine, but the site offers
  no composed hook and the README's section is gone.
- **The payout path is built**, not coming: `companion.createScriptV2`, `companion.payoutAccounts`,
  `encodePayoutAnswer`, `decodePayoutTerms`, `PAYOUT_LIMITS` (in `lossCover.ts` since 0.10.0's
  Lossback). The README's "Paying through the companion" section says how a pair uses it, and
  `scripts.ts`'s doc string no longer calls it unbuilt.
- **The README**: the walkthrough (the local build, the simulator, the submission with its fee, the
  checks, the automatic approval, the deploy, the config made on the page or with the SDK, the
  launch), the reading lane for a program you deployed, what the reading states and how to write
  for it, and the pair patterns. The /sdk pages and the briefs on /sdk/build say the same.

## 0.11.0 (13 Oct 2026)

The launchpad's partner fee, live on mainnet (verified build `614760c7…` of bordrless-programs
`9e644e7`; bordrless-programs `docs/partner-fee.md`). The launchpad's largest creator fee is now
1,000 bps (10%, `Config.max_creator_fee_bps`), and so is a side's creator fee, holder fee and burn
together (`rule_bounds.max_rules_fee_bps`, 300 before); the holder fee (2%) and the burn (1%) keep
their own bounds.

### The partner fee

- `buildCreatePartnerConfig(creator, args, partner, partnerShareBps, { authorShareBps?, cut?, hookTimelocked? })`
  (or `launch.createPartnerConfig`): a launch config whose every launch, whoever makes it, pays
  `partner` `partnerShareBps` of its creator fee (1 to 10,000 bps of it, `MAX_PARTNER_SHARE_BPS`)
  as bridged SOL on every claim, Meteora-style. It may list an author's share too (at most 10,000 in
  all with the partner's) and carry a custom hook's SOL cut. Fixed for ever. The partner's holding
  of bridged SOL must exist before its coins' fees are claimed.
- `launch.distributeFees(mint, quoteMint, config, creator, partner, author?)`: anyone pays a partner
  launch's creator fees out to every party at once, each to its own fixed holding (no signer but the
  fee payer).
- `launch.claimCreatorFees(..., author, partner)` and `launch.claimAuthorFees(..., partner)` take the
  partner's accounts (`launch.partnerAccounts`); a launch that pays a partner refuses a claim without
  them (`PartnerAccountsMissing`). `partnerOf(connection, launch)` reads them.
- `feeSplit(amount, authorShareBps, partnerShareBps)` splits a claim as the program does.
- `partnerFeeAddress`, `decodePartnerFee` (`PartnerFeeAccount`), `Launch.partnerShareBps`,
  `LaunchConfigAccount.partnerShareBps`; the events `PartnerConfigured`, `LaunchPartner`,
  `PartnerFeesPaid`; the errors `InvalidPartnerShare`, `InvalidPartner`, `PartnerAccountsMissing`,
  `NoPartnerShare`, `PartnerOnCompanion` (a companion coin can't launch from a partner config); the
  launchpad's IDL.

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
- **A Workshop hook's SOL cut: `hook.json`** (docs/workshop.md "A hook's SOL cut"): a hook with
  `quote_cut` says its caps beside `src/` (`{"version":1,"quoteCut":{"maxBuyBps":1..1000,
  "maxSellBps":0..1000}}`), and the Workshop makes its config with them. `checkHookJson` (the
  Workshop's own check), `hookJson`, `HOOK_JSON_EXAMPLE`; from @bordrless/shared (`hookDeclaration.ts`):
  `HOOK_FILE`, `HOOK_DECLARATION_LIMITS`, `parseHookDeclaration`, `hookDeclarationOf`,
  `hookDeclarationOfFiles`, `canonicalHookJson`, `quoteCutWords`, `quoteCutDetails`,
  `quoteCutPaidBps`, `HookDeclaration`, `HookQuoteCut`.

## 0.9.0 (12 Oct 2026)

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
