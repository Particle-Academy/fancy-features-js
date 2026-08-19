import { describe, expect, it } from "vitest";

import { createFeatures } from "../src/manager";
import { InMemoryUsageStore } from "../src/usage";
import type { FeatureSource, OverageEvent, UsageStore, Subject, BillingPeriod } from "../src/contract";

const user = { id: "u1" };

function catalogSource(grant: Record<string, unknown>): FeatureSource {
  return {
    name: "catalog",
    grantsFor: () => [{ key: "ai-tokens", type: "resource", enabled: true, ...grant } as never],
  };
}

/**
 * A store that predates overage: `getUsage` / `addUsage` and nothing else.
 *
 * Most hosts wrote one of these, which is the whole reason overage is opt-in in
 * this runtime rather than switched on by a migration as it is in the PHP twin.
 */
class LegacyStore implements UsageStore {
  private cells = new Map<string, number>();

  private key(subject: Subject, feature: string, period?: BillingPeriod): string {
    return `${(subject as { id: string }).id}::${feature}::${period?.start?.getTime() ?? "_"}`;
  }

  getUsage(subject: Subject, feature: string, period?: BillingPeriod): number {
    return this.cells.get(this.key(subject, feature, period)) ?? 0;
  }

  addUsage(subject: Subject, feature: string, amount: number, period?: BillingPeriod): void {
    const k = this.key(subject, feature, period);
    this.cells.set(k, Math.max(0, (this.cells.get(k) ?? 0) + amount));
  }
}

describe("billable overage", () => {
  it("refuses consumption past the included quantity when no overage is configured", async () => {
    const f = createFeatures({ sources: [catalogSource({ includedQuantity: 100 })] });

    expect(await f.tryConsume("ai-tokens", user, 100)).toBe(true);
    // `overageLimit` unset means NO overage. Every configuration written before
    // 0.5.0 has it unset, so this is what keeps the ruling opt-in.
    expect(await f.tryConsume("ai-tokens", user, 1)).toBe(false);
    expect(await f.overageFor("ai-tokens", user)).toBe(0);
  });

  it("permits and records consumption inside the overage band", async () => {
    const events: OverageEvent[] = [];
    const f = createFeatures({
      sources: [catalogSource({ includedQuantity: 100, overageLimit: 50 })],
    });
    f.onOverage((e) => {
      events.push(e);
    });

    expect(await f.tryConsume("ai-tokens", user, 90)).toBe(true);
    expect(await f.overageFor("ai-tokens", user)).toBe(0);

    // Straddles the included line: 10 of these 30 are free, 20 are billable.
    expect(await f.tryConsume("ai-tokens", user, 30)).toBe(true);
    expect(await f.overageFor("ai-tokens", user)).toBe(20);

    // Already above the line: all 10 are billable, and the 20 already recorded
    // are NOT re-billed. A naive `max(0, after - included)` answers 30 here.
    expect(await f.tryConsume("ai-tokens", user, 10)).toBe(true);
    expect(await f.overageFor("ai-tokens", user)).toBe(30);

    expect(events.map((e) => e.units)).toEqual([20, 10]);
    expect(events.at(-1)?.totalUnits).toBe(30);
    expect(events.at(-1)?.includedQuantity).toBe(100);
  });

  it("enforces the end of the overage band", async () => {
    const f = createFeatures({
      sources: [catalogSource({ includedQuantity: 100, overageLimit: 50 })],
    });

    expect(await f.tryConsume("ai-tokens", user, 150)).toBe(true);
    // A ceiling, not an alert. A field named *_limit that does not limit is the
    // same defect in a new costume.
    expect(await f.canConsume("ai-tokens", user, 1)).toBe(false);
    expect(await f.tryConsume("ai-tokens", user, 1)).toBe(false);
    expect(await f.overageFor("ai-tokens", user)).toBe(50);
  });

  it("REFUSES overage when it cannot be recorded", async () => {
    // No `addOverage` on the store and no `onOverage` listener: nowhere to
    // write it down, so the ceiling stays at the included quantity. Unbilled
    // usage is the one failure that cannot be repaired after the fact, so the
    // default fails closed.
    const f = createFeatures({
      usage: new LegacyStore(),
      sources: [catalogSource({ includedQuantity: 100, overageLimit: 50 })],
    });

    expect(await f.tryConsume("ai-tokens", user, 100)).toBe(true);
    expect(await f.tryConsume("ai-tokens", user, 1)).toBe(false);
  });

  it("permits overage on a legacy store as soon as a listener takes responsibility", async () => {
    const events: OverageEvent[] = [];
    const f = createFeatures({
      usage: new LegacyStore(),
      sources: [catalogSource({ includedQuantity: 100, overageLimit: 50 })],
    });
    f.onOverage((e) => {
      events.push(e);
    });

    expect(await f.tryConsume("ai-tokens", user, 100)).toBe(true);
    expect(await f.tryConsume("ai-tokens", user, 10)).toBe(true);
    expect(events.map((e) => e.units)).toEqual([10]);
    // The store cannot store it, so the listener's `totalUnits` falls back to
    // this consumption rather than reporting a total it has no way to know.
    expect(events[0]?.totalUnits).toBe(10);
  });

  it("unwinds only the billable part of a refund", async () => {
    const f = createFeatures({
      usage: new InMemoryUsageStore(),
      sources: [catalogSource({ includedQuantity: 100, overageLimit: 50 })],
    });
    f.onOverage(() => {});

    await f.tryConsume("ai-tokens", user, 110);
    expect(await f.overageFor("ai-tokens", user)).toBe(10);

    // Refunding 30 units when only 10 of them were ever billable must credit 10,
    // not 30.
    await f.decrement("ai-tokens", user, 30);
    expect(await f.usageFor("ai-tokens", user)).toBe(80);
    expect(await f.overageFor("ai-tokens", user)).toBe(0);
  });

  it("does not fire the listener for a refund", async () => {
    const events: OverageEvent[] = [];
    const f = createFeatures({
      sources: [catalogSource({ includedQuantity: 100, overageLimit: 50 })],
    });
    f.onOverage((e) => {
      events.push(e);
    });

    await f.tryConsume("ai-tokens", user, 110);
    await f.decrement("ai-tokens", user, 5);

    // A credit is a decision about money; inventing one from a usage correction
    // is not this package's call.
    expect(events).toHaveLength(1);
  });

  it("records overage on the unenforced increment path too", async () => {
    const f = createFeatures({
      sources: [catalogSource({ includedQuantity: 100, overageLimit: 50 })],
    });
    f.onOverage(() => {});

    // `increment` does not ENFORCE the quota and never has. It must still
    // RECORD the billable share, or the invoice is built from a figure only
    // some code paths maintain.
    await f.increment("ai-tokens", user, 130);
    expect(await f.overageFor("ai-tokens", user)).toBe(30);
  });

  it("never accrues overage against an unlimited allowance", async () => {
    const f = createFeatures({
      sources: [catalogSource({ includedQuantity: null, overageLimit: 50 })],
    });
    f.onOverage(() => {});

    expect(await f.tryConsume("ai-tokens", user, 1_000_000)).toBe(true);
    // Unlimited is not unmetered.
    expect(await f.usageFor("ai-tokens", user)).toBe(1_000_000);
    expect(await f.overageFor("ai-tokens", user)).toBe(0);
  });

  it("takes an overage allowance from a config feature, with no catalog at all", async () => {
    const f = createFeatures({
      features: {
        "ai-tokens": { key: "ai-tokens", type: "resource", limit: 100, overageLimit: 20 },
      },
    });
    f.onOverage(() => {});

    expect(await f.tryConsume("ai-tokens", user, 115)).toBe(true);
    expect(await f.overageFor("ai-tokens", user)).toBe(15);
    expect(await f.tryConsume("ai-tokens", user, 6)).toBe(false);
  });

  it("resets overage with the billing period", async () => {
    const period = { start: new Date("2026-01-01"), end: new Date("2026-02-01") };
    const f = createFeatures({
      sources: [catalogSource({ includedQuantity: 100, overageLimit: 50 })],
    });
    f.onOverage(() => {});

    await f.tryConsume("ai-tokens", user, 130, undefined, period);
    expect(await f.overageFor("ai-tokens", user, period)).toBe(30);

    await f.resetPeriod(user, period);
    expect(await f.overageFor("ai-tokens", user, period)).toBe(0);
    expect(await f.usageFor("ai-tokens", user, period)).toBe(0);
  });

  it("refuses a negative consume rather than letting it past the ceiling", async () => {
    const f = createFeatures({ sources: [catalogSource({ includedQuantity: 100 })] });

    await expect(f.tryConsume("ai-tokens", user, -50)).rejects.toThrow(/negative/);
  });
});
