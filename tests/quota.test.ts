import { describe, it, expect } from "vitest";
import {
  createFeatures,
  InMemoryUsageStore,
  requireFeature,
  canAccessAny,
  requireFeatureMiddleware,
  FeatureAccessDeniedError,
  configureFeatures,
  feature,
  canAccessFeature,
  featureRemaining,
  enabledFeatures,
} from "../src/index";

const user = { id: "u1" };

describe("quota helpers", () => {
  it("increment / decrement / usageFor", async () => {
    const f = createFeatures({ features: { tokens: { type: "resource", limit: 100 } } });
    await f.increment("tokens", user, 30);
    expect(await f.usageFor("tokens", user)).toBe(30);
    await f.decrement("tokens", user, 10);
    expect(await f.usageFor("tokens", user)).toBe(20);
    // decrement clamps at 0
    await f.decrement("tokens", user, 1000);
    expect(await f.usageFor("tokens", user)).toBe(0);
  });

  it("tryConsume enforces the quota atomically", async () => {
    const f = createFeatures({ features: { tokens: { type: "resource", limit: 5 } } });
    expect(await f.tryConsume("tokens", user, 3)).toBe(true);
    expect(await f.tryConsume("tokens", user, 3)).toBe(false); // would exceed (3+3 > 5)
    expect(await f.tryConsume("tokens", user, 2)).toBe(true); // 3+2 == 5
    expect(await f.usageFor("tokens", user)).toBe(5);
  });

  it("tryConsume on an unlimited feature always succeeds and meters", async () => {
    const f = createFeatures({ features: { tokens: { type: "resource" } } });
    expect(await f.tryConsume("tokens", user, 1000)).toBe(true);
    expect(await f.usageFor("tokens", user)).toBe(1000);
  });

  it("resetPeriod clears usage for a period", async () => {
    const store = new InMemoryUsageStore();
    const period = { start: new Date("2026-01-01"), end: new Date("2026-02-01") };
    const f = createFeatures({ features: { tokens: { type: "resource", limit: 100 } }, usage: store });
    await f.increment("tokens", user, 40, period);
    expect(await f.usageFor("tokens", user, period)).toBe(40);
    await f.resetPeriod(user, period);
    expect(await f.usageFor("tokens", user, period)).toBe(0);
  });
});

describe("guard — requireFeature (OR logic)", () => {
  it("passes when any key is accessible", async () => {
    const f = createFeatures({ features: { a: { enabled: false }, b: { enabled: true } } });
    await expect(requireFeature(f, ["a", "b"], user)).resolves.toBeUndefined();
  });

  it("throws FeatureAccessDeniedError when none are accessible", async () => {
    const f = createFeatures({ features: { a: { enabled: false } } });
    await expect(requireFeature(f, ["a"], user)).rejects.toBeInstanceOf(FeatureAccessDeniedError);
  });

  it("throws when called with no keys (fail closed)", async () => {
    const f = createFeatures();
    await expect(requireFeature(f, [], user)).rejects.toThrow(/at least one feature/);
  });

  it("canAccessAny is the boolean predicate variant", async () => {
    const f = createFeatures({ features: { a: { enabled: true } } });
    expect(await canAccessAny(f, ["a", "b"], user)).toBe(true);
    expect(await canAccessAny(f, ["x"], user)).toBe(false);
  });
});

describe("guard — requireFeatureMiddleware (no express dep)", () => {
  it("calls next() on access", async () => {
    const f = createFeatures({ features: { a: { enabled: true } } });
    const mw = requireFeatureMiddleware(f, "a", { resolveSubject: () => user });
    let called: unknown = "untouched";
    await mw({}, {}, (err?: unknown) => {
      called = err ?? "ok";
    });
    expect(called).toBe("ok");
  });

  it("forwards FeatureAccessDeniedError to next() on denial", async () => {
    const f = createFeatures({ features: { a: { enabled: false } } });
    const mw = requireFeatureMiddleware(f, "a", { resolveSubject: () => user });
    let err: unknown;
    await mw({}, {}, (e?: unknown) => {
      err = e;
    });
    expect(err).toBeInstanceOf(FeatureAccessDeniedError);
  });

  it("invokes a custom onDenied handler", async () => {
    const f = createFeatures({ features: { a: { enabled: false } } });
    let denied: string[] | undefined;
    const mw = requireFeatureMiddleware(f, ["a", "b"], {
      resolveSubject: () => user,
      onDenied: (_req, _res, features) => {
        denied = features;
      },
    });
    await mw({}, {}, () => {});
    expect(denied).toEqual(["a", "b"]);
  });
});

describe("bound module helpers", () => {
  it("route through the configured default instance", async () => {
    const f = configureFeatures({
      features: { "use-mcp": { enabled: true }, tokens: { type: "resource", limit: 50 } },
    });
    expect(feature()).toBe(f);
    expect(await feature("use-mcp", user)).toBe(true);
    expect(await canAccessFeature("use-mcp", user)).toBe(true);
    expect(await featureRemaining("tokens", user)).toBe(50);
    expect(await enabledFeatures(user)).toContain("use-mcp");
  });
});
