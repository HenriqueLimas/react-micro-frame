# react-micro-frame

Stream trusted HTML fragments from independently deployed applications directly into a React page. The host can fetch and progressively render a fragment during React SSR, adopt it during hydration, and fetch future updates in the browser.

> This package intentionally provides no iframe-style security boundary. Embedded HTML, CSS, and scripts are part of the host document and must be trusted.

## Status

This repository is an initial implementation of the provider/runtime architecture. It supports a single progressive HTML stream per `<MicroFrame>`. Multiplexed slots and out-of-order remote streams are not implemented yet.

## Installation

```sh
npm install react-micro-frame
```

React 19 and Node 20 or newer are required.

## Architecture

`MicroFrameProvider` is the control plane. It gives each component request-scoped `started` and `completed` resources used by Suspense and Error Boundaries.

The server runtime is the data plane. React's normal pipeable output passes through a downstream composer which recognizes opaque micro-frame markers and inserts remote response bytes between them. React's renderer is not patched or replaced.

In the browser, the client runtime adopts server-rendered content or streams a new response into the same opaque marker range with [`writable-dom`](https://github.com/marko-js/writable-dom).

## Node server rendering

```tsx
import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { MicroFrame, MicroFrameProvider } from "react-micro-frame";
import { createMicroFrameServerRuntime } from "react-micro-frame/server";

function App() {
  return (
    <main>
      <h1>Host application</h1>

      <MicroFrame
        src="/embedded"
        loading={<p>Loading embedded application…</p>}
        error={(error) => <p>Could not load: {error.message}</p>}
      />

      <footer>Host footer</footer>
    </main>
  );
}

export function render(request, response) {
  const nonce = response.locals.nonce;
  const runtime = createMicroFrameServerRuntime({
    origin: `${request.protocol}://${request.get("host")}`,
    requestHeaders: request.headers,
    // Forward credentials deliberately. No incoming headers are forwarded by default.
    forwardHeaders: ["cookie", "authorization", "accept-language"],
    nonce,
  });

  let rendered;
  rendered = renderToPipeableStream(
    <MicroFrameProvider runtime={runtime}>
      <App />
    </MicroFrameProvider>,
    {
      nonce,
      onShellReady() {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        void runtime.pipe(rendered, response).catch((error) => {
          console.error(error);
          response.destroy(error);
        });
      },
      onShellError(error) {
        runtime.abort(error);
        response.statusCode = 500;
        response.end("Unable to render page");
      },
      onError(error) {
        console.error(error);
      },
    },
  );

  response.on("close", () => {
    if (!response.writableEnded) runtime.abort();
  });
}
```

The composer applies backpressure and pauses later React output while an in-order micro-frame is streaming.

### Server policy

By default, only the configured `origin` is allowed and no incoming request headers are forwarded. Additional origins and forwarded headers must be explicit:

```ts
createMicroFrameServerRuntime({
  origin: "https://www.example.com",
  allowedOrigins: [
    "https://www.example.com",
    "https://fragments.example.com",
  ],
  forwardHeaders: ["cookie", "accept-language"],
});
```

## Browser hydration and fetching

Create one client runtime for the React root:

```tsx
import { hydrateRoot } from "react-dom/client";
import { MicroFrameProvider } from "react-micro-frame";
import { createMicroFrameClientRuntime } from "react-micro-frame/client";

const runtime = createMicroFrameClientRuntime();

hydrateRoot(
  document,
  <MicroFrameProvider runtime={runtime}>
    <App />
  </MicroFrameProvider>,
);
```

If the server-rendered `src` matches, the runtime adopts the existing stream and does not fetch it twice. When `src` changes, it clears the opaque range, aborts the previous generation, and streams the new response in the browser.

The client runtime:

- Uses an `AbortController` per generation.
- Implements actual browser-side timeouts.
- Preserves UTF-8 characters split across chunks.
- Waits for blocking assets through `writable-dom`.
- Avoids duplicate requests caused by React Strict Mode effect replay.

## Component API

```ts
interface MicroFrameProps {
  src: string;
  headers?: Record<string, string>;
  cache?: RequestCache;
  timeout?: number; // Defaults to 30 seconds; 0 disables it.
  fetch?: (url, init, defaultFetch) => Promise<Response>;
  loading?: React.ReactNode;
  error?: React.ReactNode | ((error: Error) => React.ReactNode);
  className?: string;
  style?: React.CSSProperties;
}
```

A custom fetch can alter the method or body while retaining the runtime's environment-specific fetch:

```tsx
<MicroFrame
  src="/embedded/search"
  fetch={(url, init, defaultFetch) =>
    defaultFetch(url, {
      ...init,
      method: "POST",
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "camera" }),
    })
  }
/>
```

## Suspense and errors

The remote body is not rendered by React. A small status resource suspends until the independent DOM stream completes:

1. Suspense displays `loading` while waiting for the first response body chunk.
2. The first chunk resolves `started`, removes the loading fallback, and begins progressive rendering in the opaque host.
3. A separate, visually empty Suspense boundary waits for `completed` so late stream failures still reach the Error Boundary.
4. Completion settles after the response and blocking browser resources finish.

The runtime—not the Error Boundary—aborts requests and clears partial DOM before surfacing an error. Server failures after streaming starts are also handled by the composer because React Error Boundaries are not general server-stream error handlers.

## Current limitations

- Embedded responses must be trusted HTML fragments valid inside a `<div>`.
- Relative assets in a fragment resolve against the host document URL.
- Script side effects cannot be undone when a frame reloads.
- Server start, completion, and error signaling uses inline runtime scripts; pass a CSP nonce when required.
- The opaque host must never be reconciled by React. The implementation keeps it memoized and uses stable comment anchors.
- Out-of-order remote insertion is not yet supported.
- Multiplexed SSE/NDJSON slots are not yet supported.
- A browser integration suite for blocking scripts, styles, preloads, hydration during an active stream, and CSP should be added before a production release.

## Playground

The Vite playground demonstrates one SSR and hydrated React host consuming two independently streamed micro-frames:

- A React fragment server.
- A Marko fragment server.

```sh
npm run playground
```

Open http://127.0.0.1:5173. See [`playground/README.md`](playground/README.md) for the application layout and E2E commands.

## Development

```sh
npm install
npm run check
npm test
npm run build
npm run test:e2e
```
