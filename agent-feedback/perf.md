# Performance

Runtime speed and bundle size opportunities. Format and rules: [README.md](README.md).

## Add parallel server composition to avoid head-of-line blocking

`src/server.ts:149` | 2026-07-16 | impact:high | effort:high

The server runtime starts micro-frame fetches concurrently, but `compose()` fully drains each response with `yield* consume(entry)` before it can reach the next frame marker in the React output. A slow frame therefore prevents every later frame from rendering even when their responses are ready. Add an explicit out-of-order or parallel mode that emits all hosts in the shell and delivers buffered responses or targeted progressive chunks without corrupting HTML parser context.
