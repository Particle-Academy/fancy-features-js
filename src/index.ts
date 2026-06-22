// ---- THE SHARED FEATURE CONTRACT (§2) — fancy-features owns; fancy-catalog mirrors ----
export type {
  FeatureType,
  Subject,
  BillingPeriod,
  FeatureGrant,
  FeatureSource,
  UsageStore,
  AccessResult,
  Feature,
  FeatureGroup,
} from "./contract";

// ---- FeatureManager + factory ----
export {
  FeatureManager,
  createFeatures,
  type FeatureManagerOptions,
  type PreStrategy,
  type PreRemainingStrategy,
  type GateResolver,
} from "./manager";

// ---- Registry ----
export {
  FeatureRegistry,
  type FeatureDefinition,
  type FeatureDefinitionInput,
} from "./registry";

// ---- Groups + GroupStore ----
export {
  FeatureGroupRegistry,
  InMemoryGroupStore,
  defaultSubjectKey,
  type GroupStore,
} from "./groups";

// ---- Usage ----
export { InMemoryUsageStore } from "./usage";

// ---- Guard + optional middleware ----
export {
  requireFeature,
  canAccessAny,
  requireFeatureMiddleware,
  FeatureAccessDeniedError,
  type GenericMiddleware,
  type RequireFeatureMiddlewareOptions,
} from "./guard";

// ---- Bound module helpers (feature(), canAccessFeature(), …) ----
export {
  feature,
  canAccessFeature,
  hasFeature,
  featureRemaining,
  enabledFeatures,
  setDefaultFeatures,
  configureFeatures,
  getDefaultFeatures,
} from "./helpers";
