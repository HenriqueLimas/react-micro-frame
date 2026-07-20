# Suspected Bugs

Out-of-scope defects noticed while working on something else. Format and rules: [README.md](README.md).

## Settle handles when a prepared server entry never reaches the composer

`src/server.ts:73` | 2026-07-16 | impact:med | effort:med

`prepare()` starts the request immediately, but request failures and timeouts only reject `started` and `completed` inside `consume()` or `bufferPayload()`. If React never emits that entry's marker—for example because rendering takes an error path—the response rejection is swallowed and both public handle promises remain pending. Propagate terminal request failures to unconsumed entries, or explicitly cancel entries that are absent when composition finishes.

## Preserve both host markers after an in-order server failure

`src/server.ts:482` | 2026-07-16 | impact:med | effort:low

The in-order error settlement removes every sibling after the start marker, including the end marker. Hydration can adopt that error state, but a later client-side `src` change calls `findMarkers()` and fails because the end marker is gone, so the replacement request never starts. Clear only the nodes between the matching start and end comments, as the parallel error path already does.

## Attach pipeline error handling before starting the React stream

`src/server.ts:191` | 2026-07-20 | impact:med | effort:low

`pipe()` calls `rendered.pipe(reactOutput)` before `pipeline()` attaches an error listener to `reactOutput`. A pipeable source that immediately destroys the destination with an error produces an uncaught stream error instead of only rejecting `runtime.pipe()`. Start the pipeline (or attach an error listener) before invoking the source's `pipe`, and tear it down if `pipe` throws synchronously.
