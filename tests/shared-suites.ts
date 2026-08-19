import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSuiteFrom, type ConformanceCase, type Language } from "@particle-academy/fancy-conformance";

/**
 * Locate and run a `fancy-conformance` suite against THIS package.
 *
 * ## Why this is not just `runTable()`
 *
 * `runTable()` reads the fixtures from wherever the installed package puts
 * them, and `shared/feature-entitlement` is newer than the released fixture
 * package. Until `fancy-conformance` cuts the release carrying it, the rows have
 * to come from a checkout — so this resolves a root explicitly and iterates,
 * while still loading through `loadSuiteFrom()` so the package's own load-time
 * guards (duplicate ids, an empty skip reason, a malformed table) are the ones
 * doing the checking. A test that re-implemented those guards would be asserting
 * a copy of itself, which is the exact failure the conformance repository exists
 * to stop.
 *
 * **Delete this file and call `runTable()` directly** once the installed fixture
 * package carries the suite.
 *
 * ## A missing toolchain is a FAILURE, not a skip
 *
 * `suitesRoot` throws rather than returning null. `runners/README.md` names
 * `skipIf(!HAS_X)` as the mechanism that hid two-way drift for months: a suite
 * that silently does not run reads exactly like full coverage.
 */
export function suitesRoot(suite: string): string {
  for (const candidate of candidates()) {
    if (existsSync(join(candidate, "suites", ...suite.split("/"), "manifest.json"))) {
      return candidate;
    }
  }

  throw new Error(
    `fancy-conformance: could not find the '${suite}' fixtures.\n` +
      "Set FANCY_CONFORMANCE_ROOT to a checkout of Particle-Academy/fancy-conformance, or " +
      "install a release of @particle-academy/fancy-conformance that carries the suite.\n" +
      "This is a failure and not a skip on purpose: a conformance suite that quietly does not " +
      "run reads exactly like full coverage.",
  );
}

function candidates(): string[] {
  const found: string[] = [];

  const env = process.env.FANCY_CONFORMANCE_ROOT;
  if (env) {
    found.push(resolve(env));
  }

  // Never a fixed `../..`: the two parity harnesses fancy-conformance replaced
  // both hard-coded a relative path to a sibling checkout, so they ran in
  // exactly one directory layout and silently no-opped everywhere else.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    found.push(join(dir, "..", "fancy-conformance"));
    found.push(join(dir, "repos", "fancy-conformance"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // The resting state: the installed package's own fixtures.
  found.push(join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@particle-academy", "fancy-conformance"));

  return found;
}

export interface SuiteRun {
  suite: string;
  suiteVersion: string;
  passed: number;
  failed: number;
  skipped: number;
  cases: number;
  lines: string[];
  ok: boolean;
}

/** Run one table suite against `impl`, in the same shape `runTable()` uses. */
export function runSharedTable(
  suite: string,
  impl: (c: ConformanceCase) => unknown,
  language: Language = "node",
): SuiteRun {
  const root = suitesRoot(suite);
  const { cases } = loadSuiteFrom(root, suite);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const lines: string[] = [];

  for (const c of cases) {
    const reason = c.skip?.[language];
    if (reason !== undefined) {
      skipped++;
      lines.push(`  SKIP ${c.id} — ${reason}`);
      continue;
    }

    let actual: unknown;
    try {
      actual = impl(c);
    } catch (error) {
      failed++;
      lines.push(`  FAIL ${c.id} ${c.title}`);
      lines.push(`       threw: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (Object.is(actual, c.expected)) {
      passed++;
    } else {
      failed++;
      lines.push(`  FAIL ${c.id} ${c.title}`);
      lines.push(`       expected: ${JSON.stringify(c.expected)}`);
      lines.push(`       actual:   ${JSON.stringify(actual)}`);
    }
  }

  return {
    suite,
    suiteVersion: "(from checkout)",
    passed,
    failed,
    skipped,
    cases: cases.length,
    lines,
    ok: failed === 0,
  };
}
