# DQL Architecture

## Design goals

1. **Isolable axes.** Each of the five axes must be evaluable independently. The Orthogonality Spike (2026-07-08) validated this empirically: mean inter-axis correlation across 40 hand-crafted cases was 0.09, max 0.39.
2. **Prod-Sentinel isolation.** DQL is a new product with its own repo, endpoint, and cascade configuration. It does not extend or modify `thoughtproof-sentinel`, which carries live production traffic.
3. **Model-agnostic cascade.** The `Cascade` interface lets us swap the underlying execution path (pot-cli, HF endpoints, provider SDKs) without touching axis or aggregation logic.
4. **Fail-open on axis errors.** A single-axis exception maps to an `UNCERTAIN` result for that axis instead of failing the whole request. The aggregate then downgrades to `REVIEW` if enough axes are affected.

## Data flow

```
POST /dql/verify
  ↓
validateVerifyRequest        → 400 on malformed input
  ↓
runVerification
  ├── build 5 prompts (one per requested axis)
  ├── Promise.all(cascade.run(...) × 5)         ← axes run in parallel
  ├── parse each response → AxisResult
  └── aggregate(axisResults) → AggregateResult
  ↓
DqlResponse (200)
```

## Directory layout

```
api/
  dql/
    verify.ts        # POST /dql/verify — entry point
    axes.ts          # GET /dql/axes — metadata
    health.ts        # GET /dql/health — liveness
  index.ts           # GET / — service description
src/
  types.ts           # Public API types (DqlRequest, DqlResponse, ...)
  validation.ts      # Request-body validation
  aggregation.ts     # 5 axis verdicts → 1 aggregate
  engine/
    index.ts         # runVerification — orchestrator
    cascade.ts       # Cascade interface + StubCascade + parseAxisResponse
    axes/
      types.ts       # AxisPromptBuilder interface
      intent.ts
      scope.ts
      risk.ts
      consistency.ts
      reversibility.ts
      index.ts       # axis → prompt-builder registry
docs/
  ARCHITECTURE.md    # this file
  SPIKE-RESULTS.md   # Orthogonality Spike report
scenarios/           # empirical test cases (to grow with each spike)
```

## Extending an axis

To change how an axis prompts the model:

1. Edit the axis file (e.g. `src/engine/axes/scope.ts`).
2. Update the axis's `docs/SPIKE-RESULTS.md` row if the change alters the axis's hit-rate.
3. Add a scenario to `scenarios/` that exercises the new phrasing.

## Adding a new axis (rare)

The five axes were pre-registered and validated as orthogonal. Adding a sixth axis requires:

1. A hypothesis for what NEW failure mode it catches that the existing five miss.
2. A repeat of the Orthogonality Spike with the new axis included: mean inter-axis correlation must stay below 0.60 (the DELAY threshold).
3. Update `AXES`, `AXIS_DEFINITIONS`, add the axis file, add prompt-builder registration.
4. Update aggregation-rule calibration if the marginal-axis contribution changes typical FAIL counts.

## Wiring a real cascade

`StubCascade` is a placeholder. To wire the production cascade:

1. Implement the `Cascade` interface in a new file (e.g. `src/engine/cascade-pot.ts`) that:
   - Accepts the same `CascadeInput`
   - Calls `pot-cli`'s `runCascade` with tier-specific model config
   - Uses `parseAxisResponse` from `cascade.ts` to convert raw model output to `AxisResult`
2. Swap the `new StubCascade()` line in `api/dql/verify.ts` for the real cascade.
3. Add integration tests in `scenarios/`.

## Tier semantics

- `checkpoint` — single-model per axis. Fast, cheap, adequate for high-volume gating.
- `standard` — cascade per axis (nano → swift). Slower, stronger, for consequential decisions.

Both tiers evaluate all five axes; the difference is the depth of the per-axis evaluation.
