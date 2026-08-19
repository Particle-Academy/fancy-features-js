# AGENTS.md — fancy-features (Node/TS)

The Node twin of `particle-academy/laravel-fms`: feature flags and
metered-resource gating, framework-free.

This file describes **this repository's code**. Process rules — publishing,
versioning, backports, the support lifecycle — live in the envelope's
`AGENTS.md` and are deliberately not repeated here, because a copy in a repo
freezes at whatever the rule was when the branch was cut.

## What this package is

A `FeatureManager` that answers three questions about a subject:

- **is this feature on** (`canAccess`, `isEnabled`, `hasFeature`)
- **how much is left** (`remaining`)
- **may I take some** (`tryConsume`, `increment`, `decrement`)

It owns no storage. A `usage` store and any number of `FeatureSource`s are
injected; the manager resolves across them.

`fancy-features` owns the **`FeatureSource` contract**. `fancy-catalog` mirrors
it and re-exports it from its `./features` subpath. When the contract changes it
changes here first.

## Resolution order

Pre-strategies → registry → config → sources. First definite answer wins.
`withMergedLimit` merges an external limit only when it is **higher** — MAX
wins, so a plan can raise a quota but never silently lower one.

## Traps that have already cost something

- **`usage` / `remaining` callbacks take `(subject, context)`.** They used to
  take `(featureKey, subject, context)`. Passing three arguments bound the
  feature KEY to `subject`, so usage resolved to nothing and the allowance
  never ran out — a silent over-grant, in the direction that costs money. The
  arity dispatch in `callDefinitionCallback` supports both until 1.0. Do not
  "simplify" it away.

  Note the shape of the mistake: four callbacks in the same interface
  (`enabled`, `check`, `limit`, and these two) — and only these two were
  different. Uniformity is the safeguard.

- **A billing period must reach the reads, not just the writes.** `tryConsume`
  derives its ceiling from `remaining + used`. Both terms have to measure the
  same window; when `remaining` was period-blind the sum was a quantity that did
  not exist. Anything new on the resource path takes `period` too.

- **`remaining()` returning `null` means unlimited, not zero.** The PHP twin
  denied on null for a while, which turned the most generous configuration into
  the most restrictive outcome.

## Parity

The PHP twin is the reference for behaviour; where they disagree, that is a
finding, not a choice. Cross-runtime rows live in `fancy-conformance` — put a
fixture there rather than asserting parity in prose.

## Testing

`npm test` (vitest). No network. Anything metered gets a test that would fail if
the allowance stopped running out.
