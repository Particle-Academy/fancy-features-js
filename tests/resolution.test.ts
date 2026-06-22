import { describe, it, expect } from "vitest";
import { createFeatures, type FeatureSource } from "../src/index";

const user = { id: "u1" };

describe("resolution chain — strategy order", () => {
  it("pre-strategy out-ranks the gate (authoritative deny)", async () => {
    const f = createFeatures({
      gate: (feature) => (feature === "export" ? true : null),
    });
    f.registerPreStrategy("subscription", (feature) => (feature === "export" ? false : null));
    expect(await f.canAccess("export", user)).toBe(false);
  });

  it("falls through when a pre-strategy returns null", async () => {
    const f = createFeatures({ features: { dash: { enabled: true } } });
    let calls = 0;
    f.registerPreStrategy("noop", () => {
      calls++;
      return null;
    });
    expect(await f.canAccess("dash", user)).toBe(true);
    expect(calls).toBe(1);
  });

  it("uses the first non-null pre-strategy and skips later ones", async () => {
    const f = createFeatures();
    const order: string[] = [];
    f.registerPreStrategy("first", () => {
      order.push("first");
      return null;
    });
    f.registerPreStrategy("second", () => {
      order.push("second");
      return true;
    });
    f.registerPreStrategy("third", () => {
      order.push("third");
      return false;
    });
    expect(await f.canAccess("anything", user)).toBe(true);
    expect(order).toEqual(["first", "second"]);
  });

  it("gate is authoritative — denies even when registry would allow", async () => {
    const f = createFeatures({
      features: { admin: { enabled: true } },
      gate: (feature) => (feature === "admin" ? false : null),
    });
    expect(await f.canAccess("admin", user)).toBe(false);
  });

  it("gate null falls through to registry", async () => {
    const f = createFeatures({
      features: { reports: { enabled: true } },
      gate: () => null,
    });
    expect(await f.canAccess("reports", user)).toBe(true);
  });
});

describe("resolution chain — OR semantics across sources", () => {
  it("a group enables a feature even when config has it disabled", async () => {
    const f = createFeatures({
      features: { "use-mcp": { type: "boolean", enabled: false } },
      groups: [{ key: "pro", features: ["use-mcp"] }],
    });
    expect(await f.canAccess("use-mcp", user)).toBe(false);
    f.groupStore.assign(user, "pro");
    expect(await f.canAccess("use-mcp", user)).toBe(true);
  });

  it("a callable-gated group enables without an assignment", async () => {
    const f = createFeatures({
      features: { "use-mcp": { enabled: false } },
      groups: [
        {
          key: "beta",
          features: ["use-mcp"],
          enabled: (s) => (s as { inBeta?: boolean }).inBeta === true,
        },
      ],
    });
    expect(await f.canAccess("use-mcp", { id: "x", inBeta: false })).toBe(false);
    expect(await f.canAccess("use-mcp", { id: "x", inBeta: true })).toBe(true);
  });

  it("config map enables a feature", async () => {
    const f = createFeatures({ features: { ga: { enabled: true } } });
    expect(await f.canAccess("ga", user)).toBe(true);
  });

  it("registry check() is consulted", async () => {
    const f = createFeatures();
    f.registerFeature("premium", { check: (s) => (s as { paid?: boolean }).paid === true });
    expect(await f.canAccess("premium", { id: "p", paid: true })).toBe(true);
    expect(await f.canAccess("premium", { id: "p", paid: false })).toBe(false);
  });

  it("default deny when nothing matches", async () => {
    const f = createFeatures();
    expect(await f.canAccess("unknown", user)).toBe(false);
  });
});

describe("resolution chain — FeatureSource grants (catalog plug-in point)", () => {
  it("a boolean grant with enabled:true turns the feature on", async () => {
    const source: FeatureSource = {
      name: "catalog",
      grantsFor: () => [{ key: "use-mcp", type: "boolean", enabled: true, source: "catalog:prod_1" }],
    };
    const f = createFeatures({ sources: [source] });
    expect(await f.canAccess("use-mcp", user)).toBe(true);
  });

  it("a boolean grant with enabled:false does not turn it on", async () => {
    const source: FeatureSource = {
      name: "catalog",
      grantsFor: () => [{ key: "use-mcp", type: "boolean", enabled: false }],
    };
    const f = createFeatures({ sources: [source] });
    expect(await f.canAccess("use-mcp", user)).toBe(false);
  });

  it("a resource grant enables only while quota remains", async () => {
    const source: FeatureSource = {
      name: "catalog",
      grantsFor: () => [
        { key: "ai-tokens", type: "resource", enabled: true, includedQuantity: 5, source: "catalog:p" },
      ],
    };
    const f = createFeatures({ sources: [source] });
    expect(await f.canAccess("ai-tokens", user)).toBe(true);
    expect(await f.remaining("ai-tokens", user)).toBe(5);
    await f.increment("ai-tokens", user, 5);
    expect(await f.remaining("ai-tokens", user)).toBe(0);
    expect(await f.canAccess("ai-tokens", user)).toBe(false);
  });

  it("an async source resolves grants", async () => {
    const source: FeatureSource = {
      name: "catalog",
      grantsFor: async () => [{ key: "sso", type: "boolean", enabled: true }],
    };
    const f = createFeatures({ sources: [source] });
    expect(await f.canAccess("sso", user)).toBe(true);
  });

  it("registerSource appends a source after construction", async () => {
    const f = createFeatures();
    f.registerSource({
      name: "catalog",
      grantsFor: () => [{ key: "late", type: "boolean", enabled: true }],
    });
    expect(await f.canAccess("late", user)).toBe(true);
  });
});

describe("resource remaining + limits", () => {
  it("remaining = limit − usage, clamped ≥0", async () => {
    const f = createFeatures({ features: { tokens: { type: "resource", limit: 100 } } });
    expect(await f.remaining("tokens", user)).toBe(100);
    await f.increment("tokens", user, 40);
    expect(await f.remaining("tokens", user)).toBe(60);
    await f.increment("tokens", user, 1000);
    expect(await f.remaining("tokens", user)).toBe(0);
  });

  it("null limit ⇒ unlimited", async () => {
    const f = createFeatures({ features: { tokens: { type: "resource" } } });
    expect(await f.remaining("tokens", user)).toBe(null);
  });

  it("group override raises the limit (MAX across groups)", async () => {
    const f = createFeatures({
      features: { "ai-tokens": { type: "resource", limit: 1000 } },
      groups: [
        { key: "pro", features: ["ai-tokens"], overrides: { "ai-tokens": { limit: 5000 } } },
        { key: "ent", features: ["ai-tokens"], overrides: { "ai-tokens": { limit: 50000 } } },
      ],
    });
    f.groupStore.assign(user, "pro");
    f.groupStore.assign(user, "ent");
    expect(await f.remaining("ai-tokens", user)).toBe(50000);
  });

  it("refuses a smaller group limit when the base limit is larger", async () => {
    const f = createFeatures({
      features: { "ai-tokens": { type: "resource", limit: 100000 } },
      groups: [{ key: "pro", features: ["ai-tokens"], overrides: { "ai-tokens": { limit: 5000 } } }],
    });
    f.groupStore.assign(user, "pro");
    expect(await f.remaining("ai-tokens", user)).toBe(100000);
  });

  it("a source limit raises the cap (MAX with feature.limit)", async () => {
    const source: FeatureSource = {
      name: "catalog",
      grantsFor: () => [{ key: "ai-tokens", type: "resource", enabled: true, includedQuantity: 25000 }],
    };
    const f = createFeatures({
      features: { "ai-tokens": { type: "resource", limit: 1000 } },
      sources: [source],
    });
    expect(await f.remaining("ai-tokens", user)).toBe(25000);
  });

  it("custom usage/remaining callbacks are honored", async () => {
    const f = createFeatures();
    f.registerFeature("seats", {
      type: "resource",
      limit: 5,
      usage: () => 2,
    });
    expect(await f.remaining("seats", user)).toBe(3);

    f.registerFeature("custom", {
      type: "resource",
      remaining: () => 42,
    });
    expect(await f.remaining("custom", user)).toBe(42);
  });
});

describe("pre-remaining strategies", () => {
  it("consulted before registry; first non-null wins", async () => {
    const f = createFeatures({ features: { seats: { type: "resource", limit: 5 } } });
    f.registerPreRemainingStrategy("quota", (feature) => (feature === "seats" ? 42 : null));
    expect(await f.remaining("seats", user)).toBe(42);
  });

  it("clamps a negative verdict to 0", async () => {
    const f = createFeatures();
    f.registerPreRemainingStrategy("q", () => -7);
    expect(await f.remaining("anything", user)).toBe(0);
  });

  it("falls through when null", async () => {
    const f = createFeatures({ features: { seats: { type: "resource", limit: 5, usage: () => 2 } } });
    f.registerPreRemainingStrategy("q", () => null);
    expect(await f.remaining("seats", user)).toBe(3);
  });
});

describe("explain()", () => {
  it("reports the pre-strategy source + name", async () => {
    const f = createFeatures({ gate: () => true });
    f.registerPreStrategy("subscription", (feature) => (feature === "x" ? false : null));
    const r = await f.explain("x", user);
    expect(r.source).toBe("pre-strategy");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("subscription");
  });

  it("reports the group source for a group-enabled feature", async () => {
    const f = createFeatures({
      features: { "use-mcp": { enabled: false } },
      groups: [{ key: "pro", features: ["use-mcp"] }],
    });
    f.groupStore.assign(user, "pro");
    const r = await f.explain("use-mcp", user);
    expect(r.source).toBe("group");
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("pro");
  });

  it("decorates resource features with remaining/limit/used", async () => {
    const f = createFeatures({ features: { tokens: { type: "resource", limit: 100 } } });
    await f.increment("tokens", user, 30);
    const r = await f.explain("tokens", user);
    expect(r.remaining).toBe(70);
    expect(r.limit).toBe(100);
    expect(r.used).toBe(30);
  });

  it("source none when nothing defines the feature", async () => {
    const f = createFeatures();
    const r = await f.explain("ghost", user);
    expect(r.source).toBe("none");
    expect(r.allowed).toBe(false);
  });
});

describe("enabled()", () => {
  it("includes registry, config, group-only, and source-only features", async () => {
    const f = createFeatures({
      features: { cfg: { enabled: true }, off: { enabled: false } },
      groups: [{ key: "pro", features: ["grouponly"] }],
      sources: [
        { name: "catalog", grantsFor: () => [{ key: "srconly", type: "boolean", enabled: true }] },
      ],
    });
    f.registerFeature("reg", { enabled: true });
    f.groupStore.assign(user, "pro");
    const enabled = await f.enabled(user);
    expect(enabled).toContain("cfg");
    expect(enabled).toContain("reg");
    expect(enabled).toContain("grouponly");
    expect(enabled).toContain("srconly");
    expect(enabled).not.toContain("off");
  });
});
