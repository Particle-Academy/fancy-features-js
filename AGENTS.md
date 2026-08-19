# AGENTS.md — fancy-features (Node/TS)

The Node twin of `particle-academy/laravel-fms`: feature flags and
metered-resource gating, framework-free.

This file describes **this repository's code**. Process rules — publishing,
versioning, backports, the support lifecycle — live in the envelope's
`AGENTS.md` and are deliberately not repeated here, because a copy in a repo
freezes at whatever the rule was when the branch was cut.

## What this package is

A `FeatureManager` that answers three questions about a subject:

- **is the subject ENTITLED to this** (`canAccess`, `isEntitled`, `isEnabled`, `hasFeature`)
- **how much is left** (`remaining`, `overageFor`)
- **may I take some** (`canConsume` to read, `tryConsume` to write, `increment`, `decrement`)

It owns no storage. A `usage` store and any number of `FeatureSource`s are
injected; the manager resolves across them.

`fancy-features` owns the **`FeatureSource` contract**. `fancy-catalog` mirrors
it and re-exports it from its `./features` subpath. When the contract changes it
changes here first.

## Entitlement is not quota

`canAccess` answers **entitlement**, on every branch. It used to answer
"enabled AND quota remains" for a `FeatureSource` grant while answering
"enabled" for the same feature defined in the registry — one question with two
answers, decided by which layer the plan happened to be modelled in.

Do not re-merge them. `entitled()` in `src/quota.ts` takes `includedQuantity`
and `used` and is required to ignore them; conformance rows `0002` and `0004`
fail if it stops.

## Billable overage

`overageLimit` is a **ceiling** on consumption past the included quantity, and
**null means no overage**. That reading is load-bearing: the field was carried by
three runtimes and read by none until 0.5.0, so every configuration in existence
has it unset, and "unbounded" would make each one an unlimited spending
authority.

**Overage is permitted only when it can be RECORDED** — a store implementing
`addOverage`, or an `onOverage` listener. A host with neither keeps today's
behaviour. That is the opt-in mechanism and it fails closed on purpose: unbilled
usage is the one failure here that cannot be repaired after the fact.

`overageDelta()` is **signed**, so `increment` and `decrement` share it. Do not
split it into two functions — that is how the two directions drift.

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

- **`remaining + used` is NOT the included quantity.** `remaining` is clamped
  at zero, so once a subject is in overage that sum reports the limit as
  whatever they have already spent — and every overage figure downstream then
  measures from the wrong line. `limitFor()` resolves the limit directly; use
  it, and only fall back to the derivation where a caller-supplied `remaining`
  callback owns the answer.

## Parity

The PHP twin is the reference for behaviour; where they disagree, that is a
finding, not a choice. Cross-runtime rows live in `fancy-conformance` — put a
fixture there rather than asserting parity in prose.

## Testing

`npm test` (vitest). No network. Anything metered gets a test that would fail if
the allowance stopped running out.
