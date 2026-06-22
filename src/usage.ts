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
    for (const key of [...this.usage.keys()]) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this.usage.delete(key);
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
