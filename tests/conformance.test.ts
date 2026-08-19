import { expect, it } from "vitest";

import {
  allowsConsumption,
  canConsume,
  consumptionCeiling,
  entitled,
  overageDelta,
} from "../src/quota";
import {
  formatSummary,
  loadSuite,
  runTable,
  suiteVersion,
  type ConformanceCase,
} from "@particle-academy/fancy-conformance";

const SUITE = "shared/feature-entitlement";

/**
 * The `shared/feature-entitlement` table, run against THIS side.
 *
 * `laravel-fms` and `fancy-features` (Python) run the identical rows from the
 * identical file. That is the whole mechanism: three runtimes read one table, so
 * a divergence is a red build in whichever one drifted rather than a support
 * ticket months later.
 *
 * ## The two rows that carry the weight
 *
 * **0002** — an enabled resource grant with zero quota left is still ENTITLED.
 * Until 0.5.0 `canAccess` answered this one way for a registry feature and the
 * other way for a catalog-sourced one. An implementation that puts the quota
 * check back fails this row and 0004, and nothing else.
 *
 * **0018** — consumption that starts *above* the included line bills the whole
 * amount, not the distance from the line. The obvious
 * `Math.max(0, after - included)` answers 50 where the truth is 10, re-billing
 * every unit already recorded. That one is an invoice, not a test failure.
 *
 * Loaded from the INSTALLED package, never a relative path to a sibling
 * checkout: the conformance repo's own runner notes record why — its two older
 * parity harnesses hard-coded `../../<repo>/src/`, so they worked in exactly one
 * directory layout and silently no-op'd everywhere else, CI included.
 */

/** Moved deliberately, never automatically. A pin that follows disk asserts nothing. */
const PINNED_SUITE_VERSION = "0.4.0";

/** Dispatch one case to the implementation under test. */
function runCase(c: ConformanceCase): unknown {
  const i = c.input as Record<string, never>;
  switch (c.fn) {
    case "entitled":
      return entitled(i.enabled, i.type, i.includedQuantity, i.used);
    case "consumptionCeiling":
      return consumptionCeiling(i.includedQuantity, i.overageLimit);
    case "allowsConsumption":
      return allowsConsumption(i.used, i.amount, i.ceiling);
    case "overageDelta":
      return overageDelta(i.used, i.amount, i.includedQuantity);
    case "canConsume":
      return canConsume(i.enabled, i.includedQuantity, i.overageLimit, i.used, i.amount);
    default:
      throw new Error(`case ${c.id} calls unimplemented fn ${c.fn}`);
  }
}

it("loads the shared/feature-entitlement suite from the installed package", () => {
  // The vacuity guard, and the one that matters most. A suite that resolves,
  // returns nothing and reports "0 failed" reads exactly like full coverage.
  expect(loadSuite(SUITE).cases.length).toBeGreaterThanOrEqual(26);
  expect(suiteVersion()).toBe(PINNED_SUITE_VERSION);
});

it("agrees with the shared feature-entitlement table", () => {
  const summary = runTable(SUITE, runCase, { language: "node" });

  // Printed unconditionally, pass or fail. A summary shown only on failure
  // cannot tell anyone the suite ran at all.
  console.info(`
${formatSummary(summary)}`);

  expect(summary.ok, formatSummary(summary)).toBe(true);
});
