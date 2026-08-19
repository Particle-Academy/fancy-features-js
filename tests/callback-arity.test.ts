import { describe, expect, it, vi } from "vitest";
import { FeatureManager } from "../src/manager";

/**
 * `usage` / `remaining` callbacks take `(subject, context)`.
 *
 * They used to take `(featureKey, subject, context)`, and laravel-fms fixed
 * that in 0.8.0 — the key is already known where the callback is defined, so
 * passing it only creates an off-by-one waiting to happen. PHP dispatches on
 * the callback's arity and deprecates the old order.
 *
 * This twin never did. It passed three arguments unconditionally, so a consumer
 * writing the current, documented, two-parameter form got `subject` bound to
 * the feature KEY and `context` bound to the subject. A string is not a subject,
 * so usage resolved to nothing and the allowance never ran out — the exact
 * silent over-grant the PHP fix exists to prevent, still shipping here.
 */

function managerWith(definition: Record<string, unknown>) {
    return new FeatureManager({
        features: { "ai-tokens": { name: "AI tokens", type: "resource", limit: 100, ...definition } },
    } as never);
}

const SUBJECT = { id: 7 };

describe("usage callback arity", () => {
    it("passes (subject, context) to a two-parameter callback", async () => {
        const seen: unknown[] = [];
        const manager = managerWith({
            usage: (subject: unknown, context: unknown) => {
                seen.push(subject, context);
                return 5;
            },
        });

        await manager.remaining("ai-tokens", SUBJECT as never);

        expect(seen[0], "the first argument must be the SUBJECT, not the feature key").toEqual(SUBJECT);
    });

    it("still honours a three-parameter callback, and says it is deprecated", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const seen: unknown[] = [];
        const manager = managerWith({
            usage: (feature: unknown, subject: unknown, context: unknown) => {
                seen.push(feature, subject, context);
                return 5;
            },
        });

        await manager.remaining("ai-tokens", SUBJECT as never);

        expect(seen[0]).toBe("ai-tokens");
        expect(seen[1]).toEqual(SUBJECT);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
