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
