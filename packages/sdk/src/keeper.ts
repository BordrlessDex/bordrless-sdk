/**
 * `keeper.json` (docs/scripts.md "What a script may ask the keeper for"): what a companion script
 * asks Bordrless's keeper to bring to each step, so a script that pays holders is served without its
 * builder running a keeper. It sits at the root of the script's source, beside `src/` (where its
 * Cargo.toml would be), and goes into the Workshop with the source: the review by AI reads it beside
 * the code, the approval binds it, and the keeper serves the approved declaration of the deployed
 * program. The schema, its bounds and its plain words are @bordrless/shared's (`keeper.ts`), re-exported
 * here; `checkKeeperJson` is the Workshop's own check, to run before submitting.
 */
import { keeperDetails, keeperWords, parseKeeperDeclaration, type KeeperDeclaration } from '@bordrless/shared';

export {
  KEEPER_COMPARES,
  KEEPER_FILE,
  KEEPER_LIMITS,
  KEEPER_PAY_TO,
  KEEPER_VERSION,
  canonicalKeeperJson,
  keeperDeclarationOf,
  keeperDetails,
  keeperPerStep,
  keeperWords,
  parseKeeperDeclaration,
  type KeeperAgainst,
  type KeeperAmount,
  type KeeperCompare,
  type KeeperDeclaration,
  type KeeperHoldings,
  type KeeperHookDataFilter,
  type KeeperParse,
  type KeeperPayTo,
  type KeeperSeconds,
  type KeeperStateField,
  type KeeperWallet,
  type KeeperWidth,
} from '@bordrless/shared';

/** What `checkKeeperJson` says of a file: its normal form and the words the Workshop's page will show, or the one sentence the Workshop would refuse it with. */
export type KeeperCheck = { ok: true; declaration: KeeperDeclaration; words: string; details: string[] } | { ok: false; problem: string };

/** Checks a `keeper.json`'s text as the Workshop does when it is submitted (size, JSON, the schema and its bounds). */
export function checkKeeperJson(text: string): KeeperCheck {
  const parsed = parseKeeperDeclaration(text);
  if (!parsed.ok) return parsed;
  return { ok: true, declaration: parsed.declaration, words: keeperWords(parsed.declaration), details: keeperDetails(parsed.declaration) };
}

/** A declaration as a `keeper.json` to save beside `src/`: two-space JSON and a newline. */
export const keeperJson = (d: KeeperDeclaration): string => `${JSON.stringify(d, null, 2)}\n`;

/**
 * The template's example (a dividend script and its hook, the shape of the Workshop pair "Whale
 * Bait"): every holder with 1 base unit to under 20,000,000 tokens (6 decimals) whose hook data
 * (byte 1, a u32 the hook stamps with floor(t / 300) when the script pays) is not of the script's
 * current epoch (floor(now / epoch_secs), `epoch_secs` the u32 at byte 41 of the script's state, a
 * whole multiple of 300), each paid to its owner's bridged-SOL holding; 3 holders a step beside the
 * launch pool's swap accounts (the script sells what its hook collected), 6 without. Copy it, then
 * change the numbers to your script's layout.
 */
export const KEEPER_EXAMPLE = `{
  "version": 1,
  "holdings": {
    "minBalance": "1",
    "maxBalance": "19999999999999",
    "hookData": {
      "offset": 1,
      "width": 4,
      "compare": "ne",
      "against": { "epoch": { "secs": { "state": { "offset": 41, "width": 4 } }, "fieldUnitSecs": 300 } }
    },
    "payTo": "ownerQuoteHolding",
    "perStep": { "withSwapAccounts": 3, "withoutSwapAccounts": 6 }
  },
  "swapAccounts": true,
  "roundSecs": { "state": { "offset": 41, "width": 4 } }
}
`;
