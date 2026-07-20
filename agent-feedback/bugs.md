# Suspected Bugs

Out-of-scope defects noticed while working on something else. Format and rules: [README.md](README.md).

## Settle handles when a prepared server entry never reaches the composer

`src/server.ts:73` | 2026-07-16 | impact:med | effort:med

`prepare()` starts the request immediately, but request failures and timeouts only reject `started` and `completed` inside `consume()` or `bufferPayload()`. If React never emits that entry's marker—for example because rendering takes an error path—the response rejection is swallowed and both public handle promises remain pending. Propagate terminal request failures to unconsumed entries, or explicitly cancel entries that are absent when composition finishes.
