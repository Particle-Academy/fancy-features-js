# Changelog

Notable changes to `@particle-academy/fancy-features`.

**BREAKING** marks anything that can stop working on upgrade. This package is
pre-1.0, so breaking changes land in MINOR releases — read those entries before
upgrading.

> Entries below **1.0** were reconstructed from git history when this file was
> introduced, so they summarise commit subjects rather than consumer impact.
> Everything from the next release onward is written by hand, in the same commit
> as the change.

---

## [Unreleased]

## 0.5.0 — 2026-08-19

Two owner rulings, matched by `laravel-fms` 0.11.0 and the Python twin. **Read
the first entry before upgrading** — it is the one that can change behaviour
without anything warning you.

Full argument: `.ai/plans/fancy-commerce-gating-rulings.md`.

### Changed

- **BREAKING (silently): `canAccess` answers ENTITLEMENT, not quota.**

  A resource feature arriving from a `FeatureSource` whose quota is exhausted is
  now `canAccess === true`. It used to be `false`.

  **What to do:** if you used `canAccess` to guard a consumption, change it:

  | You wrote | Write instead |
  |---|---|
  | `if (await f.canAccess("ai-tokens", user)) { await f.increment(...) }` | `if (await f.tryConsume("ai-tokens", user, 1)) { … }` |
  | `if (await f.canAccess("ai-tokens", user)) { /* show something */ }` | `if (await f.canConsume("ai-tokens", user, 1)) { … }` |
  | `canAccess` on a boolean feature, or on a registry/config feature | nothing — unchanged |

  **Why.** The answer depended on where the feature happened to be defined: a
  registry or config resource feature was on when its `enabled`/`check` said so,
  while a grant-sourced one was on only while quota remained. Same question, two
  answers. And a quota check inside an entitlement check was never a safe gate:
  it reads, the consumption writes, and another request can spend the last unit
  in between — which is what `tryConsume` exists for. A gate that is *nearly*
  right is worse than one that obviously is not, because it stops people
  reaching for the one that is.

  Entitlement is also the more useful answer where `canAccess` is used most: a
  plan or settings page that hides a metered feature at zero remaining hides it
  at the exact moment the customer is spending most on it.

  **No deprecation shim is possible.** The only signal available would fire on
  *every* `canAccess` call for a resource feature, including the majority that
  are correct — a log flood, and a log flood is ignored. The named alternative
  is the tool.

- **`tryConsume` now throws on a negative amount** instead of quietly applying
  it. A negative "consume" is a refund wearing a disguise and walked straight
  past `used + amount <= ceiling`. *If you were doing that deliberately, call
  `decrement`.*

### Added

- **`overageLimit` does something.** It was declared on the contract, mirrored
  by `fancy-catalog`, populated by `createCatalogFeatureSource`, and **read by
  no code in this package** — one grep hit, the declaration. From 0.5.0 it is a
  **ceiling on billable consumption past `includedQuantity`**.

  | `overageLimit` | Meaning |
  |---|---|
  | unset / `null` | **No overage.** Consumption stops at `includedQuantity` — today's behaviour. |
  | `0` | The same, stated explicitly. |
  | `n > 0` | Up to `n` billable units past `includedQuantity`; refused beyond. |

  It is a *ceiling*, not a soft alert (the contract comment said "soft cap
  before block" and nothing implemented either): a field named `*Limit` that
  does not limit is the same defect in a new costume, and unbounded overage is
  unbounded liability on both sides. "Included N then unbounded" is a *pricing*
  shape and belongs on a Stripe Price as a graduated tier.

- **Overage is permitted only where it can be RECORDED.** `UsageStore` gained
  optional `getOverage` / `addOverage`, duck-typed exactly as `tryConsume` and
  `resetPeriod` already are, and `FeatureManager.onOverage(listener)` returns an
  unsubscribe function.

  **With neither, the ceiling stays at `includedQuantity` — today's behaviour.**
  That makes the whole feature opt-in by construction in the runtime where a
  host supplies its own store, and it fails closed: unbilled usage is the one
  failure here that cannot be repaired after the fact.

  *Consumer action: none unless you want it.* `InMemoryUsageStore` implements
  both. A custom store keeps working unchanged, without overage.

- **`isEntitled`**, an explicit alias for `canAccess`, and **`canConsume`**, the
  quota-aware read. **`overageFor`** reports recorded overage.

- **`Feature.overageLimit`**, so a host with no catalog can say "1,000 included,
  200 billable" in config. Resolved as MAX across the definition, group
  overrides and source grants — the same most-generous rule `limit` uses.

- **The quota arithmetic is exported** (`entitled`, `consumptionCeiling`,
  `allowsConsumption`, `overageDelta`, `canConsume`) and pinned by the shared
  `shared/feature-entitlement` conformance table alongside `laravel-fms` and the
  Python twin. Cross-runtime behaviour belongs in a fixture row, not in three
  sets of prose that agree today.

### Fixed

- **`remaining + used` was being used as the included quantity**, in the
  `tryConsume` ceiling. `remaining` is clamped at zero, so the moment a subject
  reached their limit the derived "limit" became whatever they had already
  spent — self-fulfilling, and it would have made every overage figure measure
  from the wrong line. The limit is now resolved directly.

  *No consumer action:* before 0.5.0 nothing consumed past the limit, so the
  clamped value was only ever reached at exactly the limit, where the two agree.

## 0.4.0 — 2026-08-18

### Fixed

- **Billing periods reached the writes but not the reads, so the enforced quota
  was not the configured one.** `tryConsume` derived its ceiling as
  `remaining + used`. It read `used` scoped to the billing period, but
  `remaining` with no period at all — nothing on the resource path accepted one
  — so the two terms measured different windows and their sum was a quantity
  that does not exist.

  With a lifetime total above the period total it **under-grants**, refusing
  consumption the plan allows. Reset a period without resetting lifetime and it
  **over-grants**. Neither announces itself.

  `remaining()` now takes an optional `period`, and it is threaded through the
  whole resource path (`resourceRemaining`, `resourceUsage`) so both terms
  measure the same window.

### Added

- `remaining(feature, subject, context, period?)` — the fourth argument is new
  and optional. Omitting it keeps the previous lifetime-scoped behaviour, which
  is the right answer to a different question.


## 0.3.0 — 2026-08-18

### Fixed

- **`usage` / `remaining` callbacks were passed the feature key as the subject,
  so metered features silently metered nothing.** These callbacks take
  `(subject, context)` — the same shape as `enabled`, `check` and `limit` in the
  same interface. This package passed three arguments unconditionally, and typed
  them that way, so a consumer writing the documented two-parameter form got the
  feature KEY bound to `subject`. A string is not a subject, usage resolved to
  nothing, and **the allowance never ran out** — an over-grant, in the direction
  that costs money.

  `laravel-fms` fixed this in its 0.8.0 and dispatches on the callback's arity.
  This twin never did, so the two runtimes have disagreed ever since: the same
  callback meters correctly on PHP and not at all here.

  Now identical to PHP — a two-parameter callback receives `(subject, context)`,
  a three-parameter one is still honoured with a deprecation warning, and
  support for the old order is removed at 1.0. Both shapes type-check.

  **What to do:** if your callback takes `(key, subject, context)`, it keeps
  working and now warns; drop the first parameter. If it takes
  `(subject, context)` you were affected — check whether any metered allowance
  has been failing to run out.


## 0.2.0 — 2026-08-07

### Changed

- **BREAKING — Node 18 is no longer supported.** `engines.node` moves from `>=18` to `>=22`.

  **What you must do:** on Node 22 or newer, nothing. Note npm only *warns* on an `engines` mismatch while **pnpm fails the install**, so this surfaces differently depending on your package manager. Node 18 is end-of-life and 20 is maintenance-only.

### Why

These are the kit 0.5 platform floors, applied across every package at once so a consumer never has to resolve a mix. **No API changed, nothing was removed, nothing was renamed** — only what the package requires.


## 0.1.1 — 2026-07-04

- Maintenance only (3 internal commits).

## 0.1.0 — 2026-06-23

### Added

- initial commit — @particle-academy/fancy-features (Node/TS mirror of laravel-fms)
