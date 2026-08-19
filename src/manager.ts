import type {
  AccessResult,
  BillingPeriod,
  Feature,
  FeatureGrant,
  FeatureGroup,
  FeatureSource,
  OverageListener,
  Subject,
  UsageStore,
} from "./contract";
import { allowsConsumption, consumptionCeiling, entitled, overageDelta } from "./quota";
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
/**
 * Invoke a `usage` / `remaining` definition callback.
 *
 * These take `(subject, context)`. They used to take
 * `(featureKey, subject, context)`, and laravel-fms fixed that in 0.8.0 — the
 * key is already known where the callback is defined, so passing it only
 * creates an off-by-one waiting to happen.
 *
 * This twin kept passing three arguments unconditionally, so a consumer writing
 * the current, documented two-parameter form got `subject` bound to the feature
 * KEY. A string is not a subject, so usage resolved to nothing and the allowance
 * never ran out — a silent over-grant, in the direction that costs money.
 *
 * Dispatch on arity, exactly as the PHP twin does: `Function.length` is the
 * declared parameter count, so a 3-param callback is unambiguously the old
 * order. Support for it is removed at 1.0.
 */
function callDefinitionCallback<R>(
  callback: (...args: never[]) => R | Promise<R>,
  feature: string,
  subject: Subject,
  context?: unknown,
): R | Promise<R> {
  if (callback.length === 3) {
    console.warn(
      `fancy-features: the \`${feature}\` usage/remaining callback takes three parameters, which is the ` +
        "pre-0.8 `(feature, subject, context)` order. Change it to `(subject, context)` — the feature key is " +
        "already known where the callback is defined. Support for the old order is removed at 1.0.",
    );
    return (callback as unknown as (f: string, s: Subject, c?: unknown) => R | Promise<R>)(
      feature,
      subject,
      context,
    );
  }
  return (callback as unknown as (s: Subject, c?: unknown) => R | Promise<R>)(subject, context);
}

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
  private overageListeners: OverageListener[] = [];

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

  /**
   * Listen for billable overage as it is recorded.
   *
   * Returns an unsubscribe function.
   *
   * Registering a listener is also one of the two ways to ENABLE overage at all:
   * consumption past the included quantity is permitted only when it can be
   * recorded, either by a store implementing `addOverage` or by a listener that
   * takes responsibility for it. Unbilled usage is the one failure here that
   * cannot be repaired after the fact, so the default refuses in that direction.
   */
  onOverage(listener: OverageListener): () => void {
    this.overageListeners.push(listener);
    return () => {
      this.overageListeners = this.overageListeners.filter((l) => l !== listener);
    };
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
    //
    // ENTITLEMENT ONLY, from 0.5.0. This branch used to answer "enabled AND
    // there is quota left" for a resource grant, while steps 2-4 above answered
    // "enabled" for the same feature defined in the registry — one question with
    // two answers, decided by which layer the plan happened to be modelled in.
    // A metered feature whose allowance is exhausted is still ENTITLED: the
    // customer is still paying for it. `canConsume` is the quota-aware read.
    const grant = await this.grantFor(feature, subject, context);
    if (grant && entitled(grant.enabled, grant.type, grant.includedQuantity)) {
      return true;
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
   * An explicit alias for `canAccess` — entitlement, regardless of quota.
   *
   * Exists so a call site that MEANS entitlement says so, and never has to be
   * re-read to find out which of the two questions it was asking.
   */
  isEntitled(feature: string, subject?: Subject, context?: unknown): Promise<boolean> {
    return this.canAccess(feature, subject, context);
  }

  /**
   * Entitled AND `amount` fits under the ceiling — the quota-aware read.
   *
   * Exactly what `canAccess` answered for a source grant before 0.5.0, plus
   * billable overage: the ceiling is `includedQuantity + overageLimit`, so a
   * plan with an overage allowance permits consumption past its included
   * quantity.
   *
   * **A READ, not a gate.** Between this and the write that follows, another
   * request can take the last unit. Use `tryConsume` for an actual consumption.
   */
  async canConsume(
    feature: string,
    subject?: Subject,
    amount = 1,
    context?: unknown,
    period?: BillingPeriod,
  ): Promise<boolean> {
    if (!(await this.canAccess(feature, subject, context))) {
      return false;
    }
    const included = await this.includedFor(feature, subject, context, period);
    if (included === null) {
      return true; // unlimited, or not a resource feature
    }
    const ceiling = this.canRecordOverage()
      ? consumptionCeiling(included, await this.overageLimitFor(feature, subject, context))
      : included;
    const used = await this.usage.getUsage(subject, feature, period);
    return allowsConsumption(used, amount, ceiling);
  }

  /**
   * Remaining quantity for a resource feature. `null` ⇒ unlimited / not a
   * resource feature. Order: pre-remaining strategies → MAX(group/source limit,
   * feature.limit) − usage, clamped ≥0.
   */
  /**
   * Remaining quota. `period` scopes the usage side of the calculation — omit it
   * and you get lifetime usage, which is a different question and was the only
   * one this could answer before.
   */
  async remaining(
    feature: string,
    subject?: Subject,
    context?: unknown,
    period?: BillingPeriod,
  ): Promise<number | null> {
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
        period,
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
        period,
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
        period,
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
    period?: BillingPeriod,
  ): Promise<number | null> {
    if (typeof definition.remaining === "function") {
      return callDefinitionCallback(definition.remaining, feature, subject, context);
    }
    const rawLimit = definition.limit;
    const limit =
      typeof rawLimit === "function" ? Math.trunc(await rawLimit(subject, context)) : rawLimit;
    if (limit === null || limit === undefined) {
      return null; // unlimited
    }
    const used = await this.resourceUsage(definition, feature, subject, context, period);
    return Math.max(0, limit - used);
  }

  private async resourceUsage(
    definition: Feature,
    feature: string,
    subject: Subject,
    context?: unknown,
    period?: BillingPeriod,
  ): Promise<number> {
    if (typeof definition.usage === "function") {
      return callDefinitionCallback(definition.usage, feature, subject, context);
    }
    return this.usage.getUsage(subject, feature, period);
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

  /** Billable overage recorded for this subject + feature in the period. */
  async overageFor(feature: string, subject: Subject, period?: BillingPeriod): Promise<number> {
    if (typeof this.usage.getOverage !== "function") {
      return 0;
    }
    return this.usage.getOverage(subject, feature, period);
  }

  /**
   * Increment usage. Does NOT enforce the quota — use `tryConsume` for that.
   *
   * It does still RECORD billable overage, because recording is not enforcing,
   * and an invoice built from a figure only some code paths maintain is worse
   * than no figure at all.
   */
  async increment(
    feature: string,
    subject: Subject,
    amount = 1,
    period?: BillingPeriod,
    context?: unknown,
  ): Promise<void> {
    const included = await this.includedFor(feature, subject, context, period);
    const used = await this.usage.getUsage(subject, feature, period);
    await this.usage.addUsage(subject, feature, amount, period);
    await this.recordOverage(feature, subject, used, amount, context, period, included);
  }

  /** Decrement usage (clamped at 0), unwinding the billable share with it. */
  async decrement(
    feature: string,
    subject: Subject,
    amount = 1,
    period?: BillingPeriod,
    context?: unknown,
  ): Promise<void> {
    const included = await this.includedFor(feature, subject, context, period);
    const used = await this.usage.getUsage(subject, feature, period);
    await this.usage.addUsage(subject, feature, -amount, period);
    await this.recordOverage(feature, subject, used, -amount, context, period, included);
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
    if (amount < 0) {
      // A negative "consume" is a refund wearing a disguise, and it would walk
      // straight past `used + amount <= ceiling`. `decrement` exists for it.
      throw new RangeError(
        `tryConsume was given a negative amount (${amount}). Use decrement() to return quota; ` +
          "a negative consume bypasses the ceiling it is meant to enforce.",
      );
    }

    const included = await this.includedFor(feature, subject, context, period);

    if (included === null) {
      // Unlimited is not unmetered: a host that cannot bill what it cannot count
      // is the reason this records rather than short-circuits.
      await this.usage.addUsage(subject, feature, amount, period);
      return true;
    }

    const ceiling = this.canRecordOverage()
      ? consumptionCeiling(included, await this.overageLimitFor(feature, subject, context))
      : included;

    // `used` and the ceiling MUST measure the same window. Deriving a limit from
    // one bucket and enforcing it against another produces a quantity that does
    // not exist, and it did until 0.4.0.
    const used = await this.usage.getUsage(subject, feature, period);

    if (typeof this.usage.tryConsume === "function") {
      const taken = await this.usage.tryConsume(subject, feature, amount, ceiling as number, period);
      if (taken) {
        await this.recordOverage(feature, subject, used, amount, context, period, included);
      }
      return taken;
    }

    if (!allowsConsumption(used, amount, ceiling)) {
      return false;
    }
    await this.usage.addUsage(subject, feature, amount, period);
    await this.recordOverage(feature, subject, used, amount, context, period, included);
    return true;
  }

  // ---- Overage -------------------------------------------------------

  /**
   * The resolved quota for a resource feature, BEFORE usage is subtracted.
   *
   *   - `undefined` — not a resource feature here, or a `remaining` callback
   *     owns the answer and there is no limit to read.
   *   - `null` — unlimited.
   *   - a number — the included quantity.
   *
   * Extracted so `includedFor` does not have to reconstruct it as
   * `remaining + used`. That derivation is right only while usage is below the
   * line: `remaining` is clamped at zero, so once a subject is in overage it
   * reports the limit as whatever they have already spent — and every overage
   * calculation downstream then measures from the wrong line.
   */
  private async limitFor(
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<number | null | undefined> {
    const groupLimit = await this.resolveGroupLimitOverride(feature, subject, context);
    const sourceLimit = await this.resolveSourceLimit(feature, subject, context);
    const externalLimit = maxNullable(groupLimit, sourceLimit);

    const definition = await this.registry.definition(feature);
    const config = this.config.get(feature);

    let def: Feature;
    if (definition !== null && definition.type === "resource") {
      def = this.withMergedLimit(definition, externalLimit);
    } else if (config !== undefined && config.type === "resource") {
      def = this.withMergedLimit(config, externalLimit);
    } else if (externalLimit !== null) {
      def = { key: feature, type: "resource", limit: externalLimit };
    } else {
      // `resolveSourceLimit` returns null for BOTH "no source limit" and
      // "an unlimited grant", so the grant itself is the only way to tell.
      const grant = await this.grantFor(feature, subject, context);
      if (grant && grant.enabled && grant.type === "resource") {
        return null; // unlimited
      }
      return undefined;
    }

    if (typeof def.remaining === "function") {
      return undefined; // the callback owns it; there is no limit to read
    }

    const rawLimit = def.limit;
    const limit =
      typeof rawLimit === "function" ? Math.trunc(await rawLimit(subject, context)) : rawLimit;
    return limit === null || limit === undefined ? null : limit;
  }

  /**
   * The included quantity for a resource feature; `null` when unlimited or when
   * the feature is not metered at all.
   */
  private async includedFor(
    feature: string,
    subject: Subject,
    context?: unknown,
    period?: BillingPeriod,
  ): Promise<number | null> {
    const limit = await this.limitFor(feature, subject, context);
    if (limit !== undefined) {
      return limit;
    }
    // A `remaining` callback owns the answer, so the line has to be derived
    // from it. Correct while usage is at or below the line, which is the only
    // place a caller-supplied `remaining` gives enough to work with.
    const remaining = await this.remaining(feature, subject, context, period);
    if (remaining === null) {
      return null;
    }
    return remaining + (await this.usage.getUsage(subject, feature, period));
  }

  /**
   * Can billable overage be written down anywhere?
   *
   * **A store that cannot record overage does not get to permit it.** With
   * neither `addOverage` nor an `onOverage` listener the ceiling stays at the
   * included quantity, which is what every host had before 0.5.0. That is the
   * whole opt-in mechanism, and it fails closed: unbilled usage is the one
   * failure here that cannot be repaired after the fact.
   */
  private canRecordOverage(): boolean {
    return typeof this.usage.addOverage === "function" || this.overageListeners.length > 0;
  }

  /**
   * MAX billable-overage allowance across the definition, group overrides and
   * source grants. Same most-generous rule `limit` uses: a paid plan may raise
   * an allowance and may never silently lower one.
   */
  private async overageLimitFor(
    feature: string,
    subject: Subject,
    context?: unknown,
  ): Promise<number | null> {
    let max: number | null = null;
    const consider = (value: number | null | undefined): void => {
      if (value === null || value === undefined) {
        return;
      }
      const n = Math.trunc(value);
      if (max === null || n > max) {
        max = n;
      }
    };

    consider((await this.registry.definition(feature))?.overageLimit);
    consider(this.config.get(feature)?.overageLimit);

    for (const groupKey of await this.matchingEnabledGroups(feature, subject, context)) {
      consider(this.groupRegistry.resolvedOverrides(groupKey)[feature]?.overageLimit);
    }

    for (const source of this.sources) {
      for (const g of await source.grantsFor(subject, context)) {
        if (g.key === feature && g.enabled && g.type === "resource") {
          consider(g.overageLimit);
        }
      }
    }

    return max;
  }

  /**
   * Write down the billable share of a usage change, and announce it.
   *
   * `overageDelta` is signed, so a refund unwinds by the same arithmetic that
   * recorded it and the two directions cannot drift apart. The event fires only
   * on the way up: a credit is a decision about money, and inventing one from a
   * usage correction is not this package's call.
   */
  private async recordOverage(
    feature: string,
    subject: Subject,
    usedBefore: number,
    amount: number,
    context?: unknown,
    period?: BillingPeriod,
    knownIncluded?: number | null,
  ): Promise<void> {
    if (!this.canRecordOverage()) {
      return;
    }
    const included =
      knownIncluded === undefined
        ? await this.includedFor(feature, subject, context, period)
        : knownIncluded;
    if (included === null) {
      return; // unlimited: no included line, so nothing above it
    }

    const delta = overageDelta(usedBefore, amount, included);
    if (delta === 0) {
      return;
    }

    if (typeof this.usage.addOverage === "function") {
      await this.usage.addOverage(subject, feature, delta, period);
    }

    if (delta > 0) {
      const recorded = await this.overageFor(feature, subject, period);
      for (const listener of this.overageListeners) {
        await listener({
          feature,
          subject,
          units: delta,
          totalUnits: recorded > 0 ? recorded : delta,
          includedQuantity: included,
          period,
        });
      }
    }
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
