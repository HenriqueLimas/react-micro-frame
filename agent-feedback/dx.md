# Developer Experience

Friction in builds, tests, tooling, or repo workflows. Format and rules: [README.md](README.md).

## Make workspace type checks independent of transient `dist` cleanup

`playground/react-client/tsconfig.json` | 2026-07-16 | impact:low | effort:low

Running `npm run check` concurrently with `npm run build` intermittently produces TS7016 errors for `react-micro-frame` because tsup removes `dist` before regenerating its declarations while the playground resolves the workspace package through those files. This makes otherwise independent validation commands unsafe to parallelize. Consider a TypeScript path mapping to the package source for workspace checks, or otherwise keep declaration resolution available throughout builds.

## Upgrade the development toolchain off vulnerable esbuild 0.27

`package-lock.json:2426` | 2026-07-16 | impact:low | effort:med

`npm audit` reports GHSA-g7r4-m6w7-qqqr for `esbuild@0.27.7`, which can expose arbitrary files through a development server on Windows under limited local conditions. The version is pulled through build and playground tooling rather than the published runtime; upgrade the relevant tsup/Vite dependency paths or apply a compatible override to esbuild 0.28.1 or newer.
