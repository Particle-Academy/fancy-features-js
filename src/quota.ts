/**
 * The quota arithmetic, as pure functions.
 *
 * Every decision this package makes about a metered feature reduces to one of
 * these, and they are framework-free and side-effect-free so the shared
 * `shared/feature-entitlement` conformance table can hold this runtime,
 * `laravel-fms` and `fancy-features` (Python) to identical answers.
 * Cross-runtime behaviour belongs in a fixture row, not in three sets of prose
 * that agree today.
 *
 * ## Entitlement is not quota
 *
 * `entitled()` is deliberately blind to `includedQuantity` and `used`. Until
 * 0.5.0 the answer depended on where the feature happened to be defined: a
 * registry or config feature was on when its `enabled`/`check` said so, while a
 * feature arriving from a `FeatureSource` was on only while quota remained. One
 * question, two answers. `canConsume()` is the quota-aware read.
 *
 * ## Everything here is a WHOLE UNIT
 *
 * A resource feature is counted, never measured. No fractional unit, no rate, no
 * proportional split. Money enters only when a host multiplies recorded overage
 * units by a unit amount in minor units, which this package never does.
 */

/**
 * Is the subject entitled to the feature at all?
 *
 * `includedQuantity` and `used` are accepted and IGNORED. They are in the
 * signature because the conformance table hands them over and requires the
 * answer not to move — an implementation that starts consulting them has
 * re-merged two different questions, which is the defect this replaced.
 */
export function entitled(
  enabled: boolean,
  _type: "boolean" | "resource" = "boolean",
  _includedQuantity?: number | null,
  _used = 0,
): boolean {
  return enabled;
}

/**
 * The highest total usage a subject may reach: the included quantity plus
 * whatever billable overage is permitted above it.
 *
 * `null` in means unlimited, and `null` out means the same — there is no
 * included line to exceed, so an overage allowance is meaningless and is
 * ignored rather than added to something.
 *
 * A `null` or `0` overage limit means NO overage. Not an arbitrary reading: the
 * field was carried by three runtimes and consulted by none until 0.5.0, so
 * every configuration in existence has it unset. Reading it as "unbounded"
 * would turn each of them into an unlimited spending authority.
 */
export function consumptionCeiling(
  includedQuantity: number | null | undefined,
  overageLimit: number | null | undefined,
): number | null {
  if (includedQuantity === null || includedQuantity === undefined) {
    return null;
  }
  return includedQuantity + Math.max(0, overageLimit ?? 0);
}

/**
 * Does this request fit under the ceiling?
 *
 * All-or-nothing, on purpose. A request for 150 units against 100 remaining is
 * refused rather than partly filled: the answer is a boolean, so a caller that
 * got 100 has no way to learn that it did, and callers do not check quantities
 * they were never told about.
 *
 * `<=`, not `<`. A plan that says 100 has to permit the hundredth unit.
 */
export function allowsConsumption(
  used: number,
  amount: number,
  ceiling: number | null | undefined,
): boolean {
  if (ceiling === null || ceiling === undefined) {
    return true;
  }
  return used + amount <= ceiling;
}

/**
 * How many of the units in this consumption are BILLABLE OVERAGE.
 *
 * Signed on purpose: a refund passes a negative `amount` and gets a negative
 * delta, so `increment` and `decrement` share one function and cannot drift
 * apart. The caller clamps the stored total at zero.
 *
 * Subtracting the overage that existed BEFORE the call is what makes this
 * composable over a period. The obvious `Math.max(0, after - included)` is wrong
 * for a subject already in overage — it re-bills every unit already recorded,
 * every time.
 */
export function overageDelta(
  used: number,
  amount: number,
  includedQuantity: number | null | undefined,
): number {
  if (includedQuantity === null || includedQuantity === undefined) {
    return 0;
  }
  const after = used + amount;
  return Math.max(0, after - includedQuantity) - Math.max(0, used - includedQuantity);
}

/**
 * Entitled AND it fits — the quota-aware read.
 *
 * This is what `canAccess` answered for a `FeatureSource` grant before 0.5.0. It
 * is a READ: between it and the write that follows, another request can spend
 * the last unit. Use `tryConsume` to gate an actual consumption; use this to
 * decide what to show someone.
 */
export function canConsume(
  enabled: boolean,
  includedQuantity: number | null | undefined,
  overageLimit: number | null | undefined,
  used: number,
  amount: number,
): boolean {
  if (!enabled) {
    return false;
  }
  return allowsConsumption(used, amount, consumptionCeiling(includedQuantity, overageLimit));
}
