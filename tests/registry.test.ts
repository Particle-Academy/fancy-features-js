import { describe, it, expect } from "vitest";
import { FeatureRegistry } from "../src/index";

describe("FeatureRegistry — definition forms", () => {
  it("resolves an object definition", async () => {
    const r = new FeatureRegistry();
    r.register("a", { type: "boolean", enabled: true, name: "A" });
    const def = await r.definition("a");
    expect(def).toMatchObject({ key: "a", type: "boolean", enabled: true, name: "A" });
  });

  it("resolves a factory function", async () => {
    const r = new FeatureRegistry();
    r.register("b", () => ({ type: "resource", limit: 10 }));
    const def = await r.definition("b");
    expect(def).toMatchObject({ key: "b", type: "resource", limit: 10 });
  });

  it("resolves an async factory function", async () => {
    const r = new FeatureRegistry();
    r.register("c", async () => ({ enabled: true }));
    const def = await r.definition("c");
    expect(def).toMatchObject({ key: "c", enabled: true });
  });

  it("resolves a class with a definition() method", async () => {
    class MyFeature {
      definition() {
        return { type: "resource" as const, limit: 99 };
      }
    }
    const r = new FeatureRegistry();
    r.register("d", MyFeature);
    const def = await r.definition("d");
    expect(def).toMatchObject({ key: "d", type: "resource", limit: 99 });
  });

  it("resolves an object instance with a definition() method", async () => {
    const r = new FeatureRegistry();
    r.register("e", { definition: () => ({ enabled: true, name: "E" }) });
    const def = await r.definition("e");
    expect(def).toMatchObject({ key: "e", enabled: true, name: "E" });
  });

  it("returns null for unregistered keys", async () => {
    const r = new FeatureRegistry();
    expect(await r.definition("nope")).toBe(null);
  });

  it("tracks has() and keys()", () => {
    const r = new FeatureRegistry();
    r.register("x", { enabled: true });
    r.register("y", { enabled: false });
    expect(r.has("x")).toBe(true);
    expect(r.has("z")).toBe(false);
    expect(r.keys()).toEqual(["x", "y"]);
  });
});
