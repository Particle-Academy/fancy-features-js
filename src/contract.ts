/**
 * THE SHARED FEATURE CONTRACT — single source of truth.
 *
 * `@particle-academy/fancy-features` OWNS these types. `@particle-academy/fancy-catalog`
 * mirrors the three integration types (`FeatureType`, `FeatureGrant`, `FeatureSource`)
 * VERBATIM in its `./features` subpath. TypeScript is structural, so a catalog-built
 * `FeatureSource` is assignable to the features-built one with NO build-time dependency —
 * this is what lets the two packages be built in parallel and stay standalone.
 *
 * Keep these byte-identical with the contract spec
 * (`.ai/plans/fancy-catalog-features-contract.md` §2).
 */

// ---- Core feature types (fancy-features owns; catalog mirrors FeatureType/FeatureGrant/FeatureSource) ----

export type FeatureType = "boolean" | "resource";

/** Opaque caller-defined subject (user/org/subscription handle). */
export type Subject = unknown;

/** A billing window for metered usage (the PHP feature_usages period). */
export interface BillingPeriod {
  start?: Date | null;
  end?: Date | null;
}

/**
 * A resolved entitlement for ONE feature, for ONE subject — what a FeatureSource returns.
 * (The Node analog of a `product_feature_configs` pivot row resolved for a subscription.)
 */
/**
 * A `usage` / `remaining` callback. Current form first; the legacy three-param
 * order is accepted until 1.0 so existing consumers keep compiling.
 */
export type FeatureUsageCallback<R> =
  | ((s: Subject, c?: unknown) => R | Promise<R>)
  | ((key: string, s: Subject, c?: unknown) => R | Promise<R>);

export interface FeatureGrant {
  key: string; // feature key (== Feature.key == ProductFeature.key)
  type: FeatureType; // "boolean" | "resource"
  enabled: boolean; // included / on for this subject?
  includedQuantity?: number | null; // resource: quota per period (null = unlimited)
  /**
   * Resource: BILLABLE OVERAGE permitted past `includedQuantity`, as a CEILING.
   *
   * `null` or `0` means no overage — consumption stops at the included
   * quantity. That reading is load-bearing rather than arbitrary: this field was
   * carried by three runtimes and read by NONE until 0.5.0, so every
   * configuration in existence has it unset, and reading `null` as "unbounded"
   * would turn each of them into an unlimited spending authority.
   *
   * Consumption inside the band is permitted only when it can be RECORDED — see
   * `UsageStore.addOverage`.
   */
  overageLimit?: number | null;
  source?: string; // provenance for explain(), e.g. "catalog:prod_123"
  config?: Record<string, unknown>;
}

/**
 * THE INTEGRATION EXTENSION POINT. A pluggable source of per-subject grants.
 * fancy-catalog implements this (subscription → product → product-features).
 * fancy-features consumes any number of these as the last link in its resolution chain.
 * Replaces the PHP "Database strategy / Fms service / pre-strategy" catalog bridge.
 */
export interface FeatureSource {
  readonly name: string; // for explain()/debug, e.g. "catalog"
  grantsFor(subject: Subject, context?: unknown): FeatureGrant[] | Promise<FeatureGrant[]>;
}

/** Usage tracking for resource features (the PHP FeatureUsage table) — an adapter. */
export interface UsageStore {
  getUsage(subject: Subject, featureKey: string, period?: BillingPeriod): number | Promise<number>;
  addUsage(
    subject: Subject,
    featureKey: string,
    amount: number,
    period?: BillingPeriod,
  ): void | Promise<void>;
  /** Atomic check-and-increment for quota enforcement (the PHP tryIncrement under row-lock). */
  tryConsume?(
    subject: Subject,
    featureKey: string,
    amount: number,
    limit: number,
    period?: BillingPeriod,
  ): boolean | Promise<boolean>;
  resetPeriod?(subject: Subject, period: BillingPeriod): void | Promise<void>;
  /**
   * Billable overage recorded for this subject + feature in the period.
   *
   * Optional, and duck-typed exactly as `tryConsume` and `resetPeriod` are.
   * **A store that cannot record overage does not get to permit it**: with
   * neither `addOverage` nor an `onOverage` listener, consumption is refused at
   * `includedQuantity`, which is the behaviour every host has today. Unbilled
   * usage is the one failure here that cannot be repaired after the fact, so
   * the default refuses in that direction.
   */
  getOverage?(subject: Subject, featureKey: string, period?: BillingPeriod): number | Promise<number>;
  /**
   * Record a signed change in billable overage. Negative for a refund; the store
   * clamps the stored total at zero, as `addUsage` already does for usage.
   */
  addOverage?(
    subject: Subject,
    featureKey: string,
    amount: number,
    period?: BillingPeriod,
  ): void | Promise<void>;
}

/**
 * Billable consumption past the included quantity, as it is recorded.
 *
 * ## This is where the package stops
 *
 * It records overage; it does not invoice it. Reporting metered usage to Stripe
 * needs the *subscription item* id — the thing that maps a subscription to one
 * specific price — which a headless gating engine does not have, should not look
 * up, and cannot know at all for a host metering something Stripe never bills
 * for.
 *
 * `units` is what THIS consumption added; `totalUnits` is the running total for
 * the period. Providers differ on which they want, so both are here and neither
 * has to be recomputed by a listener that would get it subtly wrong.
 */
export interface OverageEvent {
  feature: string;
  subject: Subject;
  /** Billable units added by this consumption. Always > 0. */
  units: number;
  /** Total billable units for the period, including `units`. */
  totalUnits: number;
  includedQuantity: number;
  period?: BillingPeriod;
}

/** A listener for {@link OverageEvent}. Registered with `FeatureManager.onOverage`. */
export type OverageListener = (event: OverageEvent) => void | Promise<void>;

/** What canAccess()/check() resolve to under the hood; exposed via explain(). */
export interface AccessResult {
  allowed: boolean;
  remaining?: number | null; // resource only
  limit?: number | null;
  used?: number;
  source: string; // "pre-strategy" | "gate" | "registry" | "group" | "config" | "source:<name>" | "none"
  reason?: string;
}

// ---- Feature & group definition shapes (fancy-features only; not mirrored by catalog) ----

export interface Feature {
  key: string;
  name?: string;
  description?: string;
  type?: FeatureType; // default "boolean"
  enabled?: boolean | ((s: Subject, c?: unknown) => boolean | Promise<boolean>);
  check?: (s: Subject, c?: unknown) => boolean | Promise<boolean>; // custom access check
  limit?: number | ((s: Subject, c?: unknown) => number | Promise<number>); // resource
  /**
   * Resource: billable overage permitted past `limit`, as a CEILING.
   *
   * Here as well as on `FeatureGrant` so a host with no catalog can still say
   * "1,000 included, 200 billable". Resolved as MAX across the definition, any
   * group override and any source grant — the same most-generous rule `limit`
   * uses, for the same reason: a paid plan may raise an allowance and may never
   * silently lower one.
   */
  overageLimit?: number | null;
  /**
   * Metered usage. Takes `(subject, context)` — the same shape as `enabled`,
   * `check` and `limit` above.
   *
   * The three-parameter `(key, subject, context)` form is the pre-0.8 order and
   * is still accepted, with a deprecation warning, until 1.0. It is the reason
   * this callback used to be the odd one out in this interface: a consumer who
   * reasonably assumed uniformity wrote two parameters, got the feature KEY
   * bound to `subject`, and metered nothing — so the allowance never ran out.
   */
  usage?: FeatureUsageCallback<number>; // resource
  remaining?: FeatureUsageCallback<number | null>;
}

export interface FeatureGroup {
  key: string;
  name?: string;
  description?: string;
  features: string[];
  extends?: string[]; // 1 level deep, cycle-checked
  overrides?: Record<string, Partial<Feature>>; // e.g. { "ai-tokens": { limit: 50000 } }
  enabled?: boolean | ((s: Subject, c?: unknown) => boolean | Promise<boolean>); // callable gate (no assignment needed)
}
