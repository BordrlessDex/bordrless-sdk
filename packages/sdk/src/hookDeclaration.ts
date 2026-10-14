/**
 * `hook.json` (docs/workshop.md "A hook's SOL cut"): what a hook asks of the launch config it runs
 * under. A hook that takes SOL on trades implements the launchpad's `quote_cut` (live since the
 * launchpad of 13 Oct 2026), and the launchpad asks it only on a coin whose config was made with
 * `create_quote_cut_config` (`launch.createQuoteCutConfig`), which records the most it may take of
 * each side. In the Workshop the builder never makes that config: the hook says its caps in
 * `hook.json`, at the root of its source beside `src/` (where its Cargo.toml would be), the review
 * by AI reads it beside the code, the approval binds it, and the Workshop makes the config with the
 * approved caps. A hook with `quote_cut` must declare them, and a declaration without `quote_cut` is
 * refused. The schema, its bounds and its plain words are @bordrless/shared's (`hookDeclaration.ts`),
 * re-exported here; `checkHookJson` is the Workshop's own check of the file, to run before submitting.
 */
import { hookDeclarationWords, parseHookDeclaration, quoteCutDetails, type HookDeclaration } from '@bordrless/shared';

export {
  HOOK_DECLARATION_LIMITS,
  HOOK_DECLARATION_VERSION,
  HOOK_FILE,
  canonicalHookJson,
  hookDeclarationOf,
  hookDeclarationOfFiles,
  hookDeclarationWords,
  parseHookDeclaration,
  quoteCutDetails,
  quoteCutPaidBps,
  quoteCutWords,
  type HookDeclaration,
  type HookDeclarationParse,
  type HookQuoteCut,
} from '@bordrless/shared';

/** What `checkHookJson` says of a file: its normal form and the words the Workshop's page will show, or the one sentence the Workshop would refuse it with. */
export type HookJsonCheck = { ok: true; declaration: HookDeclaration; words: string; details: string[] } | { ok: false; problem: string };

/** Checks a `hook.json`'s text as the Workshop does when it is submitted (size, JSON, the schema and its bounds). The static checks also hold it to the code: a `quote_cut` in the `#[program]` module answering `-> Result<u16>`. */
export function checkHookJson(text: string): HookJsonCheck {
  const parsed = parseHookDeclaration(text);
  if (!parsed.ok) return parsed;
  return { ok: true, declaration: parsed.declaration, words: hookDeclarationWords(parsed.declaration), details: quoteCutDetails(parsed.declaration.quoteCut) };
}

/** A declaration as a `hook.json` to save beside `src/`: two-space JSON and a newline. */
export const hookJson = (d: HookDeclaration): string => `${JSON.stringify(d, null, 2)}\n`;

/**
 * An example: a hook whose `quote_cut` takes up to 8% of a buy's SOL and nothing on sells (the
 * launchpad never asks on sells when `maxSellBps` is 0). The buy cap is above 0: the launchpad asks
 * on every buy, and the hook may answer 0 there. Change the numbers to your hook's.
 */
export const HOOK_JSON_EXAMPLE = `{
  "version": 1,
  "quoteCut": { "maxBuyBps": 800, "maxSellBps": 0 }
}
`;
