import { describe, it, expect } from "vitest";
import { FeatureGroupRegistry, InMemoryGroupStore } from "../src/index";

describe("FeatureGroupRegistry — resolution + extends", () => {
  it("exposes a group's own features and groupsContaining", () => {
    const r = new FeatureGroupRegistry();
    r.register({ key: "pro", features: ["use-mcp", "ai-tokens"] });
    expect(r.has("pro")).toBe(true);
    expect(r.resolvedFeatures("pro")).toEqual(["use-mcp", "ai-tokens"]);
    expect(r.groupsContaining("use-mcp")).toEqual(["pro"]);
  });

  it("resolves features from extended groups one level deep", () => {
    const r = new FeatureGroupRegistry();
    r.register({ key: "pro", features: ["use-mcp", "ai-tokens"] });
    r.register({ key: "ent", extends: ["pro"], features: ["sso"] });
    expect(r.resolvedFeatures("ent").sort()).toEqual(["ai-tokens", "sso", "use-mcp"]);
  });

  it("does NOT expand extends transitively (one level only)", () => {
    const r = new FeatureGroupRegistry();
    r.register({ key: "base", features: ["a"] });
    r.register({ key: "mid", extends: ["base"], features: ["b"] });
    r.register({ key: "top", extends: ["mid"], features: ["c"] });
    // top sees mid's own features (b, c) but NOT base's `a` (no transitive).
    expect(r.resolvedFeatures("top").sort()).toEqual(["b", "c"]);
  });

  it("merges overrides from extends; own overrides win", () => {
    const r = new FeatureGroupRegistry();
    r.register({ key: "pro", features: ["ai-tokens"], overrides: { "ai-tokens": { limit: 5000 } } });
    r.register({
      key: "ent",
      extends: ["pro"],
      features: [],
      overrides: { "ai-tokens": { limit: 50000 } },
    });
    expect(r.resolvedOverrides("ent")["ai-tokens"]?.limit).toBe(50000);
  });

  it("throws on a self-referential extends", () => {
    const r = new FeatureGroupRegistry();
    r.register({ key: "loop", extends: ["loop"], features: ["x"] });
    expect(() => r.resolvedFeatures("loop")).toThrow(/cannot extend itself/);
  });

  it("throws on a two-group cycle", () => {
    const r = new FeatureGroupRegistry();
    r.register({ key: "a", extends: ["b"], features: [] });
    r.register({ key: "b", extends: ["a"], features: [] });
    expect(() => r.resolvedFeatures("a")).toThrow(/cycle detected/);
  });

  it("isEnabledByCallable honors boolean and callable gates", async () => {
    const r = new FeatureGroupRegistry();
    r.register({ key: "always", features: [], enabled: true });
    r.register({ key: "beta", features: [], enabled: (s) => (s as { b?: boolean }).b === true });
    r.register({ key: "manual", features: [] });
    expect(await r.isEnabledByCallable("always", {})).toBe(true);
    expect(await r.isEnabledByCallable("beta", { b: true })).toBe(true);
    expect(await r.isEnabledByCallable("beta", { b: false })).toBe(false);
    expect(await r.isEnabledByCallable("manual", {})).toBe(false);
  });
});

describe("InMemoryGroupStore — polymorphic assignment", () => {
  it("assigns, lists, detaches, and syncs", () => {
    const store = new InMemoryGroupStore();
    const user = { id: "u1" };
    expect(store.list(user)).toEqual([]);
    store.assign(user, "pro");
    store.assign(user, "pro"); // idempotent
    expect(store.list(user)).toEqual(["pro"]);
    expect(store.has(user, "pro")).toBe(true);
    store.assign(user, "ent");
    store.detach(user, "pro");
    expect(store.list(user)).toEqual(["ent"]);
    store.sync(user, ["a", "b"]);
    expect(store.list(user).sort()).toEqual(["a", "b"]);
  });

  it("keys distinct subjects independently", () => {
    const store = new InMemoryGroupStore();
    store.assign({ id: "u1" }, "pro");
    store.assign({ id: "u2" }, "ent");
    expect(store.list({ id: "u1" })).toEqual(["pro"]);
    expect(store.list({ id: "u2" })).toEqual(["ent"]);
  });
});
