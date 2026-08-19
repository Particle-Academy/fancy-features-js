import { describe, expect, it } from "vitest";
import { FeatureManager } from "../src/manager";

/**
 * A billing period has to reach the WHOLE resource path, not just the writes.
 *
 * `tryConsume` derived its ceiling as `remaining + used`. It read `used` scoped
 * to the period but `remaining` with no period at all, because nothing on the
 * resource path accepted one — so the two terms measured different windows and
 * their sum was a quantity that does not exist. With a lifetime total above the
 * period total it under-grants; reset the period without resetting lifetime and
 * it over-grants. Either way the quota being enforced is not the quota
 * configured.
 */

/** A store that can tell period-scoped reads from lifetime ones. */
function periodStore(lifetime: number, thisPeriod: number) {
    const reads: Array<string | undefined> = [];
    return {
        reads,
        getUsage: (_s: unknown, _f: string, period?: string) => {
            reads.push(period);
            return period === undefined ? lifetime : thisPeriod;
        },
        addUsage: () => {},
    };
}

const SUBJECT = { id: 1 };
const PERIOD = "2026-08" as never;

function managerWith(store: ReturnType<typeof periodStore>) {
    return new FeatureManager({
        features: { "ai-tokens": { name: "AI tokens", type: "resource", limit: 100 } },
        usage: store,
    } as never);
}

describe("billing period on the resource path", () => {
    it("scopes remaining to the period it was asked about", async () => {
        const store = periodStore(80, 10);
        const manager = managerWith(store);

        const left = await manager.remaining("ai-tokens", SUBJECT as never, undefined, PERIOD);

        // 100 - 10 used this period. Reading lifetime (80) would answer 20.
        expect(left).toBe(90);
        expect(store.reads, "the store must be consulted WITH the period").toContain(PERIOD);
    });

    it("enforces the configured quota, not a sum of two different windows", async () => {
        const store = periodStore(80, 10);
        const manager = managerWith(store);

        // 95 against a 100 limit with 10 used this period must be refused;
        // the old `remaining(lifetime) + used(period)` made the ceiling 30.
        expect(await manager.tryConsume("ai-tokens", SUBJECT as never, 95, undefined, PERIOD)).toBe(false);
        expect(await manager.tryConsume("ai-tokens", SUBJECT as never, 85, undefined, PERIOD)).toBe(true);
    });
});
