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
export interface FeatureGrant {
  key: string; // feature key (== Feature.key == ProductFeature.key)
  type: FeatureType; // "boolean" | "resource"
  enabled: boolean; // included / on for this subject?
  includedQuantity?: number | null; // resource: quota per period (null = unlimited)
  overageLimit?: number | null; // resource: soft cap before block
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
}

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
  usage?: (key: string, s: Subject, c?: unknown) => number | Promise<number>; // resource
  remaining?: (
    key: string,
    s: Subject,
    c?: unknown,
  ) => number | null | Promise<number | null>;
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
