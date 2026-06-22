import type {
  AccessResult,
  BillingPeriod,
  Feature,
  FeatureGrant,
  FeatureGroup,
  FeatureSource,
  Subject,
  UsageStore,
} from "./contract";
import { FeatureRegistry, type FeatureDefinitionInput } from "./registry";
import {
  FeatureGroupRegistry,
  InMemoryGroupStore,
  type GroupStore,
} from "./groups";
import { InMemoryUsageStore } from "./usage";

/**
 * A boolean pre-strategy: `(feature, subject, context) => boolean | null`.
 * Returns `true`/`false` to be authoritative; `null` to fall through.
 */
export type PreStrategy = (
  feature: string,
  subject: Subject,
  context?: unknown,
) => boolean | null | Promise<boolean | null>;

/** A resource `remaining()` pre-strategy: returns `number | null` (null = fall through). */
export type PreRemainingStrategy = (
  feature: string,
  subject: Subject,
  context?: unknown,
) => number | null | Promise<number | null>;

/**
 * An injected Gate resolver (the Node analog of Laravel's `Gate`). When it
 * returns a boolean it is AUTHORITATIVE (can deny even if later sources allow);
 * `null` means "no gate defined for this feature" → fall through.
 */
export type GateResolver = (
  feature: string,
  subject: Subject,
  context?: unknown,
) => boolean | null | Promise<boolean | null>;

export interface FeatureManagerOptions {
  /** Config-defined feature map (the `config/fms.php` `features` analog). */
  features?: Record<string, FeatureDefinitionInput>;
  /** Config-defined groups (the `config/fms.php` `groups` analog). */
  groups?: FeatureGroup[];
  /** Pluggable grant sources (e.g. fancy-catalog) — the last link in the chain. */
  sources?: FeatureSource[];
  /** Usage adapter for resource features. Defaults to an in-memory store. */
  usage?: UsageStore;
  /** Polymorphic group-assignment adapter. Defaults to an in-memory store. */
  groupStore?: GroupStore;
  /** Injected Gate resolver — authoritative when it returns a boolean. */
  gate?: GateResolver;
  /** Pre-supplied registry (advanced); otherwise one is created. */
  registry?: FeatureRegistry;
  /** Pre-supplied group registry (advanced); otherwise one is created. */
  groupRegistry?: FeatureGroupRegistry;
}

/**
 * FeatureManager — headless port of `ParticleAcademy\Fms\Services\FeatureManager`.
 *
 * Resolution order (canAccess):
 *   pre-strategies → gate → registry → groups (OR) → config → sources → default deny.
 *
 * Resource `remaining`:
 *   pre-remaining strategies → MAX(group/source limit, feature.limit) − usage, clamped ≥0.
 *   `null` ⇒ unlimited.
 */
export class FeatureManager {
  readonly registry: FeatureRegistry;
  readonly groupRegistry: FeatureGroupRegistry;
  readonly groupStore: GroupStore;
  readonly usage: UsageStore;

  /** Config-defined features (the lower-priority `config` map). */
  private config: Map<string, Feature>;
  private sources: FeatureSource[];
  private gate?: GateResolver;

  private preStrategies = new Map<string, PreStrategy>();
  private preRemainingStrategies = new Map<string, PreRemainingStrategy>();

  constructor(opts: FeatureManagerOptions = {}) {
    this.registry = opts.registry ?? new FeatureRegistry();
    this.groupRegistry = opts.groupRegistry ?? new FeatureGroupRegistry();
    this.groupStore = opts.groupStore ?? new InMemoryGroupStore();
    this.usage = opts.usage ?? new InMemoryUsageStore();
    this.sources = opts.sources ? [...opts.sources] : [];
    this.gate = opts.gate;

    this.config = new Map();
    for (const [key, def] of Object.entries(opts.features ?? {})) {
      // Config features must be plain normalized objects (no factory forms).
      this.config.set(key, { ...(def as object), key } as Feature);
    }

    for (const group of opts.groups ?? []) {
      this.groupRegistry.register(group);
    }
  }

  // ---- Registration ----------------------------------------------------

  registerPreStrategy(name: string, strategy: PreStrategy): this {
    this.preStrategies.set(name, strategy);
    return this;
  }

  unregisterPreStrategy(name: string): this {
    this.preStrategies.delete(name);
    return this;
  }

  preStrategyNames(): string[] {
    return [...this.preStrategies.keys()];
  }

  registerPreRemainingStrategy(name: string, strategy: PreRemainingStrategy): this {
    this.preRemainingStrategies.set(name, strategy);
    return this;
  }

  unregisterPreRemainingStrategy(name: string): this {
    this.preRemainingStrategies.delete(name);
    return this;
  }

  preRemainingStrategyNames(): string[] {
    return [...this.preRemainingStrategies.keys()];
  }

  /** Append a `FeatureSource` (the catalog plug-in point). */
  registerSource(source: FeatureSource): this {
    this.sources.push(source);
    return this;
  }

  /** Register a programmatic feature definition (registry). */
  registerFeature(key: string, definition: FeatureDefinitionInput): this {
    this.registry.register(key, definition);
    return this;
  }

  /** Register a feature group. */
  registerGroup(group: FeatureGroup): this {
    this.groupRegistry.register(group);
    return this;
  }

  // ---- Access checks ---------------------------------------------------

  /**
   * Resolution order: pre-strategies → gate → registry → groups (OR) → config
   * → sources → default deny. OR semantics across registry/groups/config/sources:
   * any source that says "enabled" turns the feature on. A registry/config
   * feature with `enabled:false` does NOT block a group/source from activating it.
   */
  async canAccess(feature: string, subject?: Subject, context?: unknown): Promise<boolean> {
    // 0. Pre-strategies (registration order). First non-null wins, authoritative.
    for (const strategy of this.preStrategies.values()) {
      const verdict = await strategy(feature, subject, context);
      if (verdict !== null && verdict !== undefined) {
        return Boolean(verdict);
      }
    }

    // 1. Gate — authoritative when it returns a boolean (allow OR deny).
    if (this.gate) {
      const verdict = await this.gate(feature, subject, context);
      if (verdict !== null && verdict !== undefined) {
        return Boolean(verdict);
      }
    }

    // 2. Registry.
    const definition = await this.registry.definition(feature);
    if (definition !== null && (await this.checkDefinition(definition, subject, context))) {
      return true;
    }

    // 3. Groups (OR across enabled groups containing the feature).
    if ((await this.matchingEnabledGroups(feature, subject, context)).length > 0) {
      return true;
    }

    // 4. Config features map.
    const config = this.config.get(feature);
    if (config !== undefined && (await this.checkDefinition(config, subject, context))) {
      return true;
    }

    // 5. Sources (FeatureSource[]) — a grant with enabled:true turns it on.
    const grant = await this.grantFor(feature, subject, context);
    if (grant) {
      if (grant.type === "resource") {
        // Resource grant only "enables" when there's remaining quota.
        if (!grant.enabled) {
          return false;
        }
        const limit = grant.includedQuantity;
        if (limit === null || limit === undefined) {
          return true; // unlimited
        }
        const used = await this.usage.getUsage(subject, feature);
        return Math.max(0, limit - used) > 0;
      }
      if (grant.enabled) {
        return true;
      }
    }

    // 6. Default deny.
    return false;
  }

  /** Alias for canAccess. */
  isEnabled(feature: string, subject?: Subject, context?: unknown): Promise<boolean> {
    return this.canAccess(feature, subject, context);
  }

  /** Alias for canAccess. */
  hasFeature(feature: string, subject?: Subject, context?: unknown): Promise<boolean> {
    return this.canAccess(feature, subject, context);
  }

  /**
   * Remaining quantity for a resource feature. `null` ⇒ unlimited / not a
   * resource feature. Order: pre-remaining strategies → MAX(group/source limit,
   * feature.limit) − usage, clamped ≥0.
   */
  async remaining(feature: string, subject?: Subject, context?: unknown): Promise<number | null> {
    // Pre-remaining strategies. First non-null wins; clamp ≥0.
    for (const strategy of this.preRemainingStrategies.values()) {
      const verdict = await strategy(feature, subject, context);
      if (verdict !== null && verdict !== undefined) {
        return Math.max(0, Math.trunc(verdict));
      }
    }

    const groupLimit = await this.resolveGroupLimitOverride(feature, subject, context);
    const sourceLimit = await this.resolveSourceLimit(feature, subject, context);
    // Most-generous external limit (groups + sources both raise the cap).
    const externalLimit = maxNullable(groupLimit, sourceLimit);

    // Registry definition.
    const definition = await this.registry.definition(feature);
    if (definition !== null && definition.type === "resource") {
      return this.resourceRemaining(
        this.withMergedLimit(definition, externalLimit),
        feature,
        subject,
        context,
      );
    }

    // Config definition.
    const config = this.config.get(feature);
    if (config !== undefined && config.type === "resource") {
      return this.resourceRemaining(
        this.withMergedLimit(config, externalLimit),
        feature,
        subject,
        context,
      );
    }

    // No registry/config definition but a group/source provides a limit —
    // treat as a resource feature with that limit.
    if (externalLimit !== null) {
      return this.resourceRemaining(
        { key: feature, type: "resource", limit: externalLimit },
        feature,
        subject,
        context,
      );
    }

    return null;
  }

  /** All enabled feature keys for the subject (registry + config + groups + sources). */
  async enabled(subject?: Subject, context?: unknown): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const consider = async (key: string) => {
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      if (await this.canAccess(key, subject, context)) {
        out.push(key);
      }
    };

    for (const key of this.registry.keys()) {
      await consider(key);
    }
    for (const key of this.config.keys()) {
      await consider(key);
    }
    // Features only exposed through groups also count.
    for (const groupKey of await this.enabledGroupsFor(subject, context)) {
      for (const key of this.groupRegistry.resolvedFeatures(groupKey)) {
        await consider(key);
      }
    }
    // Features only exposed through sources.
    for (const source of this.sources) {
      const grants = await source.grantsFor(subject, context);
      for (const g of grants) {
        await consider(g.key);
      }
    }
    return out;
  }

  /**
   * Trace a feature's resolution to an `AccessResult`. Surfaces "why is this
   * on/off?". Mirrors `FeatureManager::explain` and fills in resource
   * `remaining`/`limit`/`used` for resource features.
   */
  async explain(feature: string, subject?: Subject, context?: unknown): Promise<AccessResult> {
    // Pre-strategies first (they out-rank Gate).
    for (const [name, strategy] of this.preStrategies) {
      const verdict = await strategy(feature, subject, context);
      if (verdict !== null && verdict !== undefined) {
        return this.fill({ allowed: Boolean(verdict), source: "pre-strategy", reason: name }, feature, subject, context);
      }
    }

    if (this.gate) {
      const verdict = await this.gate(feature, subject, context);
      if (verdict !== null && verdict !== undefined) {
        return this.fill({ allowed: Boolean(verdict), source: "gate" }, feature, subject, context);
      }
    }

    const definition = await this.registry.definition(feature);
    if (definition !== null && (await this.checkDefinition(definition, subject, context))) {
      return this.fill({ allowed: true, source: "registry" }, feature, subject, context);
    }

    const matchingGroups = await this.matchingEnabledGroups(feature, subject, context);
    if (matchingGroups.length > 0) {
      return this.fill(
        { allowed: true, source: "group", reason: matchingGroups.join(",") },
        feature,
        subject,
        context,
      );
    }

    const config = this.config.get(feature);
    if (config !== undefined && (await this.checkDefinition(config, subject, context))) {
      return this.fill({ allowed: true, source: "config" }, feature, subject, context);
    }

    const grant = await this.grantFor(feature, subject, context);
    if (grant && grant.enabled) {
      const allowed = await this.canAccess(feature, subject, context);
      return this.fill(
        { allowed, source: `source:${grant.source ?? "?"}` },
        feature,
        subject,
        context,
      );
    }

    // Nothing enabled. Report the most-specific source that DEFINED the feature.
    if (definition !== null) {
      return this.fill({ allowed: false, source: "registry" }, feature, subject, context);
    }
    if (config !== undefined) {
      return this.fill({ allowed: false, source: "config" }, feature, subject, context);
    }
    return this.fill({ allowed: false, source: "none" }, feature, subject, context);
  }

  // ---- Group helpers ---------------------------------------------------

  /**
   * Group keys enabled for the subject — both store-assigned (via `GroupStore`)
   * and `enabled`-callable matches. Mirrors `enabledGroupsFor`.
   */
  async enabledGroupsFor(subject?: Subject, context?: unknown): Promise<string[]> {
    const keys = new Set<string>();
    if (subject !== undefined && subject !== null) {
      for (const key of await this.groupStore.list(subject)) {
        keys.add(key);
      }
    }
    for (const key of this.groupRegistry.keys()) {
      if (await this.groupRegistry.isEnabledByCallable(key, subject, context)) {
        keys.add(key);
      }
    }
    return [...keys];
  }

  /** Subset of enabled groups that ALSO contain the feature. */
  private async matchingEnabledGroups(
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<string[]> {
    const matching: string[] = [];
    for (const groupKey of await this.enabledGroupsFor(subject, context)) {
      if (this.groupRegistry.resolvedFeatures(groupKey).includes(feature)) {
        matching.push(groupKey);
      }
    }
    return matching;
  }

  /** MAX `limit` override across enabled groups containing the feature; null if none. */
  private async resolveGroupLimitOverride(
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<number | null> {
    let max: number | null = null;
    for (const groupKey of await this.matchingEnabledGroups(feature, subject, context)) {
      const overrides = this.groupRegistry.resolvedOverrides(groupKey);
      const limit = overrides[feature]?.limit;
      if (limit === undefined) {
        continue;
      }
      const value = typeof limit === "function" ? Math.trunc(await limit(subject, context)) : Math.trunc(limit);
      if (max === null || value > max) {
        max = value;
      }
    }
    return max;
  }

  // ---- Source helpers --------------------------------------------------

  /** First grant for the feature across all sources (most-recent source wins ties via order). */
  private async grantFor(
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<FeatureGrant | null> {
    for (const source of this.sources) {
      const grants = await source.grantsFor(subject, context);
      const match = grants.find((g) => g.key === feature);
      if (match) {
        return match;
      }
    }
    return null;
  }

  /** MAX `includedQuantity` across all source grants for the feature; null if none/unlimited. */
  private async resolveSourceLimit(
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<number | null> {
    let max: number | null = null;
    let sawUnlimited = false;
    let sawAny = false;
    for (const source of this.sources) {
      const grants = await source.grantsFor(subject, context);
      for (const g of grants) {
        if (g.key !== feature || !g.enabled || g.type !== "resource") {
          continue;
        }
        sawAny = true;
        if (g.includedQuantity === null || g.includedQuantity === undefined) {
          sawUnlimited = true;
          continue;
        }
        if (max === null || g.includedQuantity > max) {
          max = g.includedQuantity;
        }
      }
    }
    // An unlimited (null) grant beats any finite one. Signal "unlimited" by
    // returning null only when nothing finite is present; otherwise the finite
    // max stands (a finite grant + an unlimited grant ⇒ unlimited).
    if (sawUnlimited && sawAny) {
      return null;
    }
    return max;
  }

  // ---- Resource / definition resolution --------------------------------

  private async checkDefinition(
    definition: Feature,
    subject: Subject,
    context?: unknown,
  ): Promise<boolean> {
    if (typeof definition.check === "function") {
      return Boolean(await definition.check(subject, context));
    }
    if (definition.enabled !== undefined) {
      return this.evaluate(definition.enabled, subject, context);
    }
    // A bare definition with no gate is considered on (mirrors PHP: return true).
    return true;
  }

  private async evaluate(
    value: boolean | ((s: Subject, c?: unknown) => boolean | Promise<boolean>),
    subject: Subject,
    context?: unknown,
  ): Promise<boolean> {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "function") {
      return Boolean(await value(subject, context));
    }
    return false;
  }

  /** Replace the definition's limit with `externalLimit` only if it is higher (MAX wins). */
  private withMergedLimit(definition: Feature, externalLimit: number | null): Feature {
    if (externalLimit === null) {
      return definition;
    }
    const current = definition.limit;
    // A callable current-limit can't be compared statically — let the external win.
    const resolvedCurrent = typeof current === "function" ? null : current ?? 0;
    if (resolvedCurrent !== null && resolvedCurrent >= externalLimit) {
      return definition;
    }
    return { ...definition, limit: externalLimit };
  }

  private async resourceRemaining(
    definition: Feature,
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<number | null> {
    if (typeof definition.remaining === "function") {
      return definition.remaining(feature, subject, context);
    }
    const rawLimit = definition.limit;
    const limit =
      typeof rawLimit === "function" ? Math.trunc(await rawLimit(subject, context)) : rawLimit;
    if (limit === null || limit === undefined) {
      return null; // unlimited
    }
    const used = await this.resourceUsage(definition, feature, subject, context);
    return Math.max(0, limit - used);
  }

  private async resourceUsage(
    definition: Feature,
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<number> {
    if (typeof definition.usage === "function") {
      return definition.usage(feature, subject, context);
    }
    return this.usage.getUsage(subject, feature);
  }

  private async fill(
    partial: AccessResult,
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<AccessResult> {
    // Decorate resource features with remaining/limit/used.
    const def = (await this.registry.definition(feature)) ?? this.config.get(feature) ?? null;
    const grant = await this.grantFor(feature, subject, context);
    const isResource = def?.type === "resource" || grant?.type === "resource";
    if (!isResource) {
      return partial;
    }
    const remaining = await this.remaining(feature, subject, context);
    const used = await this.usage.getUsage(subject, feature);
    const limit = remaining === null ? null : remaining + used;
    return { ...partial, remaining, limit, used };
  }

  // ---- Quota helpers (port of Fms usage methods) ----------------------

  /** Current usage for a resource feature. */
  usageFor(feature: string, subject: Subject, period?: BillingPeriod): Promise<number> | number {
    return this.usage.getUsage(subject, feature, period);
  }

  /** Increment usage (does NOT enforce quota — use `tryConsume` for that). */
  async increment(
    feature: string,
    subject: Subject,
    amount = 1,
    period?: BillingPeriod,
  ): Promise<void> {
    await this.usage.addUsage(subject, feature, amount, period);
  }

  /** Decrement usage (clamped at 0). */
  async decrement(
    feature: string,
    subject: Subject,
    amount = 1,
    period?: BillingPeriod,
  ): Promise<void> {
    await this.usage.addUsage(subject, feature, -amount, period);
  }

  /**
   * Atomically check the quota and increment. Returns false if the feature is
   * unlimited-less, has no resolvable limit, or the increment would exceed it.
   * Uses the store's `tryConsume` when available (atomic), else falls back to
   * a remaining-check + increment. Port of `Fms::tryIncrement`.
   */
  async tryConsume(
    feature: string,
    subject: Subject,
    amount = 1,
    context?: unknown,
    period?: BillingPeriod,
  ): Promise<boolean> {
    const remaining = await this.remaining(feature, subject, context);
    if (remaining === null) {
      // Unlimited: still record usage so metering stays accurate.
      await this.usage.addUsage(subject, feature, amount, period);
      return true;
    }
    const used = await this.usage.getUsage(subject, feature, period);
    const limit = remaining + used;
    if (typeof this.usage.tryConsume === "function") {
      return this.usage.tryConsume(subject, feature, amount, limit, period);
    }
    if (remaining < amount) {
      return false;
    }
    await this.usage.addUsage(subject, feature, amount, period);
    return true;
  }

  /** Reset usage for a subject's billing period (the renewal reset). */
  async resetPeriod(subject: Subject, period: BillingPeriod): Promise<void> {
    if (typeof this.usage.resetPeriod === "function") {
      await this.usage.resetPeriod(subject, period);
    }
  }
}

/** MAX of two nullable numbers (null = "no constraint from this side"). */
function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.max(a, b);
}

/** Factory mirror of `createFeatures()` in the contract. */
export function createFeatures(opts: FeatureManagerOptions = {}): FeatureManager {
  return new FeatureManager(opts);
}
