# Playground

The playground contains three Vite applications:

| Application | URL | Purpose |
| --- | --- | --- |
| React host/client | http://127.0.0.1:5173 | Server-rendered and hydrated React page containing both micro-frames |
| React fragment server | http://127.0.0.1:5174/fragment | Independent React SSR application that provides a streamed HTML fragment |
| Marko fragment server | http://127.0.0.1:5175/fragment | Independent Marko application that provides a streamed HTML fragment |

Start all three from the repository root:

```sh
npm run playground
```

The host initially fetches both fragments on its Node server and composes them into its React SSR response. After hydration, reloading either source is handled by browser fetch and `writable-dom`. The host requests an artificial first-byte delay from the Marko endpoint so the micro-frame loading fallback is visible before Marko's first chunk.

Both fragment applications provide:

- An immediate heading and stylesheet.
- A delayed chunk, demonstrating progressive response delivery.
- An independent client-side counter: React uses a hydrated `useState` component, while Marko uses a native `<let/count>` tag variable.

The host provides controls to reload, unmount, and remount both micro-frames.

Run the browser tests with:

```sh
npx playwright install chromium
npm run test:e2e
```

The Playwright suite verifies SSR and hydration, both provider implementations, progressive endpoint delivery, browser-side source updates, React hook state, Marko tag-variable state, and unmount/remount behavior.
