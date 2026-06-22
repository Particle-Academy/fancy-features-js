import type { Subject } from "./contract";
import {
  FeatureManager,
  createFeatures,
  type FeatureManagerOptions,
} from "./manager";

/**
 * Bound module helpers — the Node analog of `laravel-fms`'s `helpers.php`
 * (`feature()`, `can_access_feature()`, `has_feature()`, `feature_remaining()`,
 * `enabled_features()`), bound to a single default instance.
 *
 * Unlike the PHP globals (resolved from the container), the default instance is
 * explicit: call `setDefaultFeatures(createFeatures(...))` once at boot, then the
 * helpers route through it. `feature()` returns the manager (or, with a key,
 * the access check) — mirroring `feature($key?)`.
 */
let defaultManager: FeatureManager | null = null;

/** Set the process-wide default `FeatureManager` the helpers route through. */
export function setDefaultFeatures(manager: FeatureManager): FeatureManager {
  defaultManager = manager;
  return manager;
}

/** Create AND install a default `FeatureManager` in one call. */
export function configureFeatures(opts: FeatureManagerOptions = {}): FeatureManager {
  return setDefaultFeatures(createFeatures(opts));
}

/** The current default manager (throws if none configured). */
export function getDefaultFeatures(): FeatureManager {
  if (!defaultManager) {
    throw new Error(
      "No default FeatureManager configured. Call setDefaultFeatures()/configureFeatures() first.",
    );
  }
  return defaultManager;
}

/**
 * `feature()` → the default manager; `feature(key, subject?, context?)` →
 * the boolean access check (mirrors the PHP `feature($key?)` overload).
 */
export function feature(): FeatureManager;
export function feature(key: string, subject?: Subject, context?: unknown): Promise<boolean>;
export function feature(
  key?: string,
  subject?: Subject,
  context?: unknown,
): FeatureManager | Promise<boolean> {
  const manager = getDefaultFeatures();
  if (key === undefined) {
    return manager;
  }
  return manager.canAccess(key, subject, context);
}

/** `can_access_feature()` — boolean access check via the default manager. */
export function canAccessFeature(
  key: string,
  subject?: Subject,
  context?: unknown,
): Promise<boolean> {
  return getDefaultFeatures().canAccess(key, subject, context);
}

/** `has_feature()` — alias of canAccess via the default manager. */
export function hasFeature(key: string, subject?: Subject, context?: unknown): Promise<boolean> {
  return getDefaultFeatures().hasFeature(key, subject, context);
}

/** `feature_remaining()` — remaining resource quantity via the default manager. */
export function featureRemaining(
  key: string,
  subject?: Subject,
  context?: unknown,
): Promise<number | null> {
  return getDefaultFeatures().remaining(key, subject, context);
}

/** `enabled_features()` — all enabled feature keys via the default manager. */
export function enabledFeatures(subject?: Subject, context?: unknown): Promise<string[]> {
  return getDefaultFeatures().enabled(subject, context);
}
