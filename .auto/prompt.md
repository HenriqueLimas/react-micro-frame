# Autoresearch: coverage at or above 90%

## Objective

Raise automated unit/integration coverage of the production TypeScript in `src/` so statements, branches, functions, and lines are each at least 90%. Add behavior-focused tests that validate meaningful contracts and failure modes. Refactor production architecture only where doing so improves cohesion or testability without weakening encapsulation or behavior.

## Metrics

- **Primary**: `branch_coverage` (percent, higher is better) — the lowest and hardest coverage dimension
- **Secondary**: `statement_coverage`, `function_coverage`, `line_coverage` — each must also reach at least 90%

## How to Run

`./.auto/measure.sh` — runs the complete Vitest suite with V8 coverage and outputs `METRIC name=number` lines.

## Files in Scope

- `test/**/*.test.ts`, `test/**/*.test.tsx` — behavior-focused unit and integration tests
- `src/**/*.{ts,tsx}` — production code, only for justified architecture/testability improvements or defects exposed by tests
- `vitest.config.ts` — coverage thresholds once the target is reached
- `.auto/*` — experiment harness, log, and resumable playbook

## Off Limits

- `playground/` and end-to-end tests, except for reading to understand public behavior
- Generated `coverage/` and `dist/`
- Removing, ignoring, excluding, or adding coverage pragmas around production code merely to inflate coverage
- Weakening assertions, deleting behavior, or replacing useful integration tests with implementation-detail tests

## Constraints

- All four V8 coverage dimensions must be >= 90% for all `src/**/*.{ts,tsx}` files combined.
- Existing tests and TypeScript checks must pass.
- Tests should exercise public behavior and realistic boundaries; avoid tests that only invoke lines without asserting outcomes.
- No new runtime dependencies.
- Preserve API compatibility and code quality. Prefer small test helpers and table-driven cases over duplication.
- Add enforceable 90% coverage thresholds to Vitest after achieving the target.

## What's Been Tried

- Baseline on 2026-07-20: statements 83.28%, branches 69.51%, functions 85.36%, lines 84.88% (30 tests). The main gaps were client lifecycle/error branches, React context/error-boundary behavior, error constructors, and server failure/parser-state branches.
- Client lifecycle and request-boundary coverage raised the metrics to statements 90.01%, branches 79.25%, functions 95.12%, lines 91.02% (40 tests). Tests exposed and fixed an unhandled rejection when a host lacked DOM markers; marker discovery now participates in normal client error settlement. Remaining target is branch coverage, especially React component branches and server abort/failure/parser-state paths.
