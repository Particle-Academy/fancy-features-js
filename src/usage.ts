import type { BillingPeriod, Subject, UsageStore } from "./contract";
import { defaultSubjectKey } from "./groups";

/**
 * In-memory `UsageStore` — the default metering adapter (the Node analog of
 * the `feature_usages` table). Keys usage by `(subject, featureKey, period)`.
 * Implements the optional `tryConsume` (atomic check-and-increment, the
 * single-process analog of the PHP `tryIncrement` row-lock) and `resetPeriod`.
 *
 * Subjects are identified by a key function (default: `.id` when present).
 */
export class InMemoryUsageStore implements UsageStore {
  private usage = new Map<string, number>();
  /**
   * Billable overage, in its own map rather than folded into `usage`.
   *
   * Recorded, never derived. `Math.max(0, used - included)` at read time is one
   * map cheaper and quietly wrong: when a plan is upgraded mid-period the
   * included quantity rises and overage that was genuinely incurred -- possibly
   * already reported to a billing provider -- vanishes from the derivation.
   */
  private overage = new Map<string, number>();
  private keyOf: (subject: Subject) => string;

  constructor(keyOf?: (subject: Subject) => string) {
    this.keyOf = keyOf ?? defaultSubjectKey;
  }

  private cell(subject: Subject, featureKey: string, period?: BillingPeriod): string {
    return `${this.keyOf(subject)}::${featureKey}::${periodKey(period)}`;
  }

  getUsage(subject: Subject, featureKey: string, period?: BillingPeriod): number {
    return this.usage.get(this.cell(subject, featureKey, period)) ?? 0;
  }

  addUsage(subject: Subject, featureKey: string, amount: number, period?: BillingPeriod): void {
    const cell = this.cell(subject, featureKey, period);
    // Clamp at 0 so decrements never drive usage negative (mirrors `decrement`).
    this.usage.set(cell, Math.max(0, (this.usage.get(cell) ?? 0) + amount));
  }

  /** Billable overage recorded against this subject + feature in the period. */
  getOverage(subject: Subject, featureKey: string, period?: BillingPeriod): number {
    return this.overage.get(this.cell(subject, featureKey, period)) ?? 0;
  }

  /** Record a signed change in billable overage. Clamped at 0, as usage is. */
  addOverage(subject: Subject, featureKey: string, amount: number, period?: BillingPeriod): void {
    const cell = this.cell(subject, featureKey, period);
    this.overage.set(cell, Math.max(0, (this.overage.get(cell) ?? 0) + amount));
  }

  /** Atomic-in-process check-and-increment. Returns false if it would exceed `limit`. */
  tryConsume(
    subject: Subject,
    featureKey: string,
    amount: number,
    limit: number,
    period?: BillingPeriod,
  ): boolean {
    const cell = this.cell(subject, featureKey, period);
    const used = this.usage.get(cell) ?? 0;
    if (limit - used < amount) {
      return false;
    }
    this.usage.set(cell, used + amount);
    return true;
  }

  /** Drop all usage rows for a subject in the given period (the renewal reset). */
  resetPeriod(subject: Subject, period: BillingPeriod): void {
    const prefix = `${this.keyOf(subject)}::`;
    const suffix = `::${periodKey(period)}`;
    for (const map of [this.usage, this.overage]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) {
          map.delete(key);
        }
      }
    }
  }
}

/** Stable cell-key for a billing period (period-less usage shares one bucket). */
function periodKey(period?: BillingPeriod): string {
  if (!period || (period.start == null && period.end == null)) {
    return "_";
  }
  return `${period.start ? +period.start : ""}-${period.end ? +period.end : ""}`;
}
