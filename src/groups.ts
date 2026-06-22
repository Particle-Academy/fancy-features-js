import type { FeatureGroup, Feature, Subject } from "./contract";

/**
 * Feature Group Registry — holds `FeatureGroup`s keyed by string and resolves
 * the `extends` chain (ONE level deep, with cycle detection) so consumers see
 * a flat set of features (and merged overrides) per group.
 *
 * Port of `FmsFeatureGroupRegistry` + the `FeatureGroup` value object's
 * `isEnabledByCallable` / `overrideFor` helpers.
 */
export class FeatureGroupRegistry {
  private groups = new Map<string, FeatureGroup>();
  private resolvedFeaturesCache = new Map<string, string[]>();
  private resolvedOverridesCache = new Map<string, Record<string, Partial<Feature>>>();

  register(group: FeatureGroup): this {
    this.groups.set(group.key, group);
    // Mutating the set invalidates the extends-resolution caches.
    this.resolvedFeaturesCache.clear();
    this.resolvedOverridesCache.clear();
    return this;
  }

  has(key: string): boolean {
    return this.groups.has(key);
  }

  get(key: string): FeatureGroup | null {
    return this.groups.get(key) ?? null;
  }

  /** All registered groups, keyed by group key. */
  all(): Record<string, FeatureGroup> {
    return Object.fromEntries(this.groups);
  }

  /** Registered group keys. */
  keys(): string[] {
    return [...this.groups.keys()];
  }

  /**
   * Resolved feature list for a group (own features + features from all
   * extended groups). One level deep — no transitive expansion. Cached.
   */
  resolvedFeatures(key: string): string[] {
    const cached = this.resolvedFeaturesCache.get(key);
    if (cached) {
      return cached;
    }
    const group = this.groups.get(key);
    if (!group) {
      return [];
    }
    let features = [...group.features];
    for (const extKey of group.extends ?? []) {
      this.guardCycle(key, extKey);
      const ext = this.groups.get(extKey);
      if (!ext) {
        continue;
      }
      features = features.concat(ext.features);
    }
    const unique = [...new Set(features)];
    this.resolvedFeaturesCache.set(key, unique);
    return unique;
  }

  /**
   * Resolved overrides for a group, merged from extends. Own overrides win
   * over extended ones (closer-to-the-leaf wins). Cached.
   */
  resolvedOverrides(key: string): Record<string, Partial<Feature>> {
    const cached = this.resolvedOverridesCache.get(key);
    if (cached) {
      return cached;
    }
    const group = this.groups.get(key);
    if (!group) {
      return {};
    }
    let overrides: Record<string, Partial<Feature>> = {};
    for (const extKey of group.extends ?? []) {
      this.guardCycle(key, extKey);
      const ext = this.groups.get(extKey);
      if (!ext) {
        continue;
      }
      overrides = mergeOverrides(overrides, ext.overrides ?? {});
    }
    // Own overrides win.
    overrides = mergeOverrides(overrides, group.overrides ?? {});
    this.resolvedOverridesCache.set(key, overrides);
    return overrides;
  }

  /** All group keys whose resolved feature list contains `feature`. */
  groupsContaining(feature: string): string[] {
    const matching: string[] = [];
    for (const key of this.groups.keys()) {
      if (this.resolvedFeatures(key).includes(feature)) {
        matching.push(key);
      }
    }
    return matching;
  }

  /**
   * Whether a group's `enabled` callable/boolean gate resolves truthy for the
   * subject (the no-assignment-needed path). Mirrors
   * `FeatureGroup::isEnabledByCallable`. Async-aware.
   */
  async isEnabledByCallable(key: string, subject: Subject, context?: unknown): Promise<boolean> {
    const group = this.groups.get(key);
    if (!group || group.enabled === undefined || group.enabled === null) {
      return false;
    }
    if (typeof group.enabled === "boolean") {
      return group.enabled;
    }
    if (typeof group.enabled === "function") {
      return Boolean(await group.enabled(subject, context));
    }
    return false;
  }

  /**
   * One-level cycle guard. Prevents a group extending itself or two groups
   * extending each other. Mirrors `FmsFeatureGroupRegistry::guardCycle`.
   */
  private guardCycle(sourceKey: string, extKey: string): void {
    if (sourceKey === extKey) {
      throw new Error(`[fancy-features] feature group \`${sourceKey}\` cannot extend itself`);
    }
    const ext = this.groups.get(extKey);
    if (!ext) {
      return;
    }
    if ((ext.extends ?? []).includes(sourceKey)) {
      throw new Error(
        `[fancy-features] feature group cycle detected: \`${sourceKey}\` and \`${extKey}\` extend each other`,
      );
    }
  }
}

/** Shallow-per-feature merge of override maps (`array_replace_recursive` analog). */
function mergeOverrides(
  base: Record<string, Partial<Feature>>,
  incoming: Record<string, Partial<Feature>>,
): Record<string, Partial<Feature>> {
  const out: Record<string, Partial<Feature>> = { ...base };
  for (const [feature, override] of Object.entries(incoming)) {
    out[feature] = { ...(out[feature] ?? {}), ...override };
  }
  return out;
}

/**
 * GroupStore — the polymorphic-assignment adapter (the Node analog of the
 * `feature_group_assignments` pivot + `HasFeatureGroups` trait). Apps plug in
 * their DB; the in-memory default is fine for tests and single-process apps.
 *
 * `subject` is opaque; the in-memory store keys by a caller-supplied subject
 * identity (see `InMemoryGroupStore`).
 */
export interface GroupStore {
  /** Group keys assigned to this subject. */
  list(subject: Subject): string[] | Promise<string[]>;
  /** Assign a subject to a group (idempotent). */
  assign(subject: Subject, groupKey: string): void | Promise<void>;
  /** Remove a subject from a group. */
  detach(subject: Subject, groupKey: string): void | Promise<void>;
  /** Sync to exactly these keys (attach missing, detach extras). */
  sync(subject: Subject, groupKeys: string[]): void | Promise<void>;
  /** Whether the subject is assigned to a group. */
  has?(subject: Subject, groupKey: string): boolean | Promise<boolean>;
}

/**
 * In-memory `GroupStore`. Subjects are identified by a key function (default:
 * the subject's `.id` when present, else the value itself). Good enough for
 * tests / single-process apps; swap in a DB-backed store in production.
 */
export class InMemoryGroupStore implements GroupStore {
  private assignments = new Map<string, Set<string>>();
  private keyOf: (subject: Subject) => string;

  constructor(keyOf?: (subject: Subject) => string) {
    this.keyOf = keyOf ?? defaultSubjectKey;
  }

  list(subject: Subject): string[] {
    return [...(this.assignments.get(this.keyOf(subject)) ?? [])];
  }

  assign(subject: Subject, groupKey: string): void {
    const id = this.keyOf(subject);
    const set = this.assignments.get(id) ?? new Set<string>();
    set.add(groupKey);
    this.assignments.set(id, set);
  }

  detach(subject: Subject, groupKey: string): void {
    this.assignments.get(this.keyOf(subject))?.delete(groupKey);
  }

  sync(subject: Subject, groupKeys: string[]): void {
    this.assignments.set(this.keyOf(subject), new Set(groupKeys));
  }

  has(subject: Subject, groupKey: string): boolean {
    return this.assignments.get(this.keyOf(subject))?.has(groupKey) ?? false;
  }
}

/** Identify a subject by `.id` (string/number) when present, else the value. */
export function defaultSubjectKey(subject: Subject): string {
  if (subject && typeof subject === "object" && "id" in subject) {
    return String((subject as { id: unknown }).id);
  }
  return String(subject);
}
