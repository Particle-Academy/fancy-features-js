import { expect, it } from "vitest";

import {
  allowsConsumption,
  canConsume,
  consumptionCeiling,
  entitled,
  overageDelta,
} from "../src/quota";
import { runSharedTable, suitesRoot } from "./shared-suites";
import { loadSuiteFrom } from "@particle-academy/fancy-conformance";

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
 */
function runCase(c: { fn?: string; id: string; input: Record<string, unknown> }): unknown {
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

it("loads the shared/feature-entitlement suite", () => {
  // The vacuity guard, and the one that matters most. A suite that resolves,
  // returns nothing and reports "0 failed" reads exactly like full coverage.
  const { cases } = loadSuiteFrom(suitesRoot(SUITE), SUITE);
  expect(cases.length).toBeGreaterThanOrEqual(26);
});

it("agrees with the shared feature-entitlement table", () => {
  const summary = runSharedTable(SUITE, runCase);

  // Printed unconditionally, pass or fail. A summary shown only on failure
  // cannot tell anyone the suite ran at all.
  const report = [
    `${summary.suite} [node] — ${summary.cases} cases`,
    `  ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
    ...summary.lines,
  ].join("\n");
  console.info(`\n${report}`);

  expect(summary.ok, report).toBe(true);
});
