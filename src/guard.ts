import type { Subject } from "./contract";
import type { FeatureManager } from "./manager";

/** Thrown by `requireFeature` when the subject has access to none of the keys. */
export class FeatureAccessDeniedError extends Error {
  readonly features: string[];
  readonly status = 403;
  constructor(features: string[]) {
    super(`Access denied: requires one of the feature(s) ${features.join(", ")}`);
    this.name = "FeatureAccessDeniedError";
    this.features = features;
  }
}

/**
 * Framework-agnostic guard — port of the `RequireFeature` middleware's core.
 * OR logic: passes if the subject can access ANY of `keys`. Throws
 * `FeatureAccessDeniedError` otherwise. (For AND logic, call it once per key.)
 *
 * `keys` must be non-empty — an empty guard fails closed (mirrors the PHP
 * "RequireFeature middleware requires at least one feature argument").
 */
export async function requireFeature(
  manager: FeatureManager,
  keys: string | string[],
  subject?: Subject,
  context?: unknown,
): Promise<void> {
  const features = Array.isArray(keys) ? keys : [keys];
  if (features.length === 0) {
    throw new Error("requireFeature requires at least one feature key.");
  }
  for (const key of features) {
    if (await manager.canAccess(key, subject, context)) {
      return;
    }
  }
  throw new FeatureAccessDeniedError(features);
}

/**
 * Boolean predicate variant of {@link requireFeature} — OR logic, returns a
 * boolean instead of throwing. Useful when you want to branch rather than abort.
 */
export async function canAccessAny(
  manager: FeatureManager,
  keys: string | string[],
  subject?: Subject,
  context?: unknown,
): Promise<boolean> {
  const features = Array.isArray(keys) ? keys : [keys];
  for (const key of features) {
    if (await manager.canAccess(key, subject, context)) {
      return true;
    }
  }
  return false;
}

/** Minimal Connect/Express-shaped handler signature (no express dependency). */
export type GenericMiddleware = (
  req: unknown,
  res: unknown,
  next: (err?: unknown) => void,
) => void | Promise<void>;

export interface RequireFeatureMiddlewareOptions {
  /** Resolve the subject from the request (e.g. `(req) => req.user`). */
  resolveSubject?: (req: unknown) => Subject | Promise<Subject>;
  /** Resolve extra context from the request. */
  resolveContext?: (req: unknown) => unknown | Promise<unknown>;
  /**
   * Custom denial handler. If omitted, the middleware calls
   * `next(FeatureAccessDeniedError)` so the host's error handler decides the
   * response (no assumption about `res.status`/`res.json`).
   */
  onDenied?: (req: unknown, res: unknown, features: string[]) => void | Promise<void>;
}

/**
 * OPTIONAL generic middleware factory — does NOT depend on express/connect.
 * Produces a `(req, res, next)` handler that runs the OR-logic guard and, on
 * denial, either calls `onDenied` or forwards `FeatureAccessDeniedError` to
 * `next` for the host's error middleware to handle.
 */
export function requireFeatureMiddleware(
  manager: FeatureManager,
  keys: string | string[],
  opts: RequireFeatureMiddlewareOptions = {},
): GenericMiddleware {
  const features = Array.isArray(keys) ? keys : [keys];
  if (features.length === 0) {
    throw new Error("requireFeatureMiddleware requires at least one feature key.");
  }
  return async (req, res, next) => {
    try {
      const subject = opts.resolveSubject ? await opts.resolveSubject(req) : undefined;
      const context = opts.resolveContext ? await opts.resolveContext(req) : undefined;
      if (await canAccessAny(manager, features, subject, context)) {
        next();
        return;
      }
      if (opts.onDenied) {
        await opts.onDenied(req, res, features);
        return;
      }
      next(new FeatureAccessDeniedError(features));
    } catch (err) {
      next(err);
    }
  };
}
