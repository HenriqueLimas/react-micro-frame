import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer as createViteServer } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const vite = await createViteServer({
  root,
  appType: "custom",
  server: {
    middlewareMode: true,
    hmr: { port: 24681, clientPort: 24681 },
  },
});

app.use((request, response, next) => {
  if (request.headers.origin === "http://127.0.0.1:5173") {
    response.setHeader("access-control-allow-origin", request.headers.origin);
    response.setHeader("vary", "origin");
  }
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

app.get("/integration/csp", (request, response) => {
  const version = Math.max(1, Number(request.query.version) || 1);

  response.status(200);
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`
    <article data-browser-fixture="csp" data-version="${version}">
      <p>Server composition ran under a strict content security policy.</p>
    </article>
  `);
});

app.get("/integration/active-hydration", (request, response) => {
  const version = Math.max(1, Number(request.query.version) || 1);

  response.status(200);
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.flushHeaders();
  response.write(`
    <article data-browser-fixture="active-hydration" data-version="${version}">
      <p data-active-stream>Server stream is active.</p>
  `);
  setTimeout(() => {
    response.end(`
      <p data-active-stream-complete>Server stream completed.</p>
    </article>
    `);
  }, 2_500);
});

app.get("/integration/preload", (request, response) => {
  const version = Math.max(1, Number(request.query.version) || 1);
  const delay = version === 1 ? 0 : 900;

  response.status(200);
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`
    <article data-browser-fixture="preload" data-version="${version}">
      <link rel="stylesheet" href="http://127.0.0.1:5174/integration/blocking-preload.css?version=${version}&delay=${delay}">
      <img data-preload-target src="http://127.0.0.1:5174/integration/preload-target.svg?version=${version}" width="20" height="20" alt="Preloaded target">
    </article>
  `);
});

app.get("/integration/blocking-preload.css", (request, response) => {
  const delay = Math.min(4_000, Math.max(0, Number(request.query.delay) || 0));

  response.status(200);
  response.setHeader("content-type", "text/css; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  setTimeout(
    () => response.end("[data-preload-target] { display: block; }"),
    delay,
  );
});

app.get("/integration/preload-target.svg", (_request, response) => {
  response.status(200);
  response.setHeader("content-type", "image/svg+xml");
  response.setHeader("cache-control", "no-store");
  response.end(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>',
  );
});

app.get("/integration/blocking-style", (request, response) => {
  const version = Math.max(1, Number(request.query.version) || 1);
  const delay = version === 1 ? 0 : 700;

  response.status(200);
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`
    <article data-browser-fixture="blocking-style" data-version="${version}">
      <link rel="stylesheet" href="http://127.0.0.1:5174/integration/blocking-style.css?version=${version}&delay=${delay}">
      <p data-styled-content>Content protected from an unstyled reveal.</p>
    </article>
  `);
});

app.get("/integration/blocking-style.css", (request, response) => {
  const delay = Math.min(4_000, Math.max(0, Number(request.query.delay) || 0));

  response.status(200);
  response.setHeader("content-type", "text/css; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  setTimeout(() => {
    response.end(`
      [data-browser-fixture="blocking-style"] [data-styled-content] {
        color: rgb(12, 34, 56);
      }
    `);
  }, delay);
});

app.get("/integration/blocking-script", (request, response) => {
  const version = Math.max(1, Number(request.query.version) || 1);
  const delay = version === 1 ? 0 : 700;

  response.status(200);
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`
    <article data-browser-fixture="blocking-script" data-version="${version}">
      <p data-before-script>Content before the blocking script.</p>
      <script src="http://127.0.0.1:5174/integration/blocking-script.js?version=${version}&delay=${delay}"></script>
      <script>
        document.currentScript.closest("[data-browser-fixture]").dataset.scriptOrder += ",inline";
      </script>
      <p data-after-script>Content after the blocking script.</p>
    </article>
  `);
});

app.get("/integration/blocking-script.js", (request, response) => {
  const version = Math.max(1, Number(request.query.version) || 1);
  const delay = Math.min(4_000, Math.max(0, Number(request.query.delay) || 0));

  response.status(200);
  response.setHeader("content-type", "text/javascript; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  setTimeout(() => {
    response.end(`
      document.currentScript.closest("[data-browser-fixture]").dataset.scriptOrder = "external-${version}";
    `);
  }, delay);
});

app.get("/fragment", async (request, response, next) => {
  try {
    const module = (await vite.ssrLoadModule(
      "/src/fragment.tsx",
    )) as typeof import("./src/fragment");
    const version = Math.max(1, Number(request.query.version) || 1);
    const delay = Math.min(
      4_000,
      Math.max(0, Number(request.query.delay) || 450),
    );

    response.status(200);
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.flushHeaders();

    const rendered = module.renderFragment({ version, delay }, response);
    response.on("close", () => {
      if (!response.writableEnded) rendered.abort();
    });
  } catch (error) {
    vite.ssrFixStacktrace(error as Error);
    next(error);
  }
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, app: "react-fragment-server" });
});

app.use(vite.middlewares);

const port = 5174;
app.listen(port, "127.0.0.1", () => {
  console.log(`React fragment playground: http://127.0.0.1:${port}/fragment`);
});
