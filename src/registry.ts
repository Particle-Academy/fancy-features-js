import type { Feature } from "./contract";

/**
 * A raw feature definition as accepted by the registry — mirrors
 * `FmsFeatureRegistry::register()` which accepts:
 *   - an object (the normalized definition)
 *   - a factory function returning the definition
 *   - a class exposing a static or instance `definition()` method
 */
export type FeatureDefinition = Omit<Feature, "key"> & { key?: string };

export type FeatureDefinitionInput =
  | FeatureDefinition
  | (() => FeatureDefinition | Promise<FeatureDefinition>)
  | { definition(): FeatureDefinition | Promise<FeatureDefinition> }
  | (new () => { definition(): FeatureDefinition | Promise<FeatureDefinition> });

/**
 * FeatureRegistry — central registry for code-defined features (boolean and
 * resource). Port of `FmsFeatureRegistry`. Supports object, factory-function,
 * and class-with-`definition()` forms; resolution is async-aware.
 */
export class FeatureRegistry {
  private definitions = new Map<string, FeatureDefinitionInput>();

  /**
   * Register a feature definition by key. The definition may be:
   *  - object: `{ name?, description?, type?, enabled?, check?, limit?, usage?, remaining? }`
   *  - function: `() => definition`
   *  - object/class exposing a `definition()` method.
   */
  register(key: string, definition: FeatureDefinitionInput): this {
    this.definitions.set(key, definition);
    return this;
  }

  /** Whether a key is registered. */
  has(key: string): boolean {
    return this.definitions.has(key);
  }

  /** All raw definitions as registered, keyed by feature key. */
  all(): Record<string, FeatureDefinitionInput> {
    return Object.fromEntries(this.definitions);
  }

  /** Registered feature keys. */
  keys(): string[] {
    return [...this.definitions.keys()];
  }

  /**
   * Resolve a single feature definition to a normalized `Feature` (with its
   * `key` populated), or `null` if unregistered. Async-aware: factory
   * functions and `definition()` methods may return a Promise.
   */
  async definition(key: string): Promise<Feature | null> {
    const raw = this.definitions.get(key);
    if (raw === undefined) {
      return null;
    }

    const normalize = (def: FeatureDefinition): Feature => ({ ...def, key });

    // Plain object definition (has no callable `definition` and is not a function).
    if (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).definition !== "function") {
      return normalize(raw as FeatureDefinition);
    }

    // Object exposing an instance `definition()` method.
    if (typeof raw === "object" && raw !== null && typeof (raw as { definition: unknown }).definition === "function") {
      const def = await (raw as { definition(): FeatureDefinition | Promise<FeatureDefinition> }).definition();
      return normalize(def);
    }

    if (typeof raw === "function") {
      // Class with `definition()` (static or instance) vs. a plain factory fn.
      const proto = (raw as { prototype?: Record<string, unknown> }).prototype;
      if (proto && typeof proto.definition === "function") {
        const instance = new (raw as new () => { definition(): FeatureDefinition | Promise<FeatureDefinition> })();
        return normalize(await instance.definition());
      }
      const staticDef = (raw as unknown as { definition?: unknown }).definition;
      if (typeof staticDef === "function") {
        return normalize(await (staticDef as () => FeatureDefinition | Promise<FeatureDefinition>)());
      }
      // Plain factory function.
      return normalize(await (raw as () => FeatureDefinition | Promise<FeatureDefinition>)());
    }

    return null;
  }
}
