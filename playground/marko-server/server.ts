import path from "node:path";
import { PassThrough } from "node:stream";
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
    hmr: { port: 24680, clientPort: 24680 },
  },
});

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin === "http://127.0.0.1:5173" || origin === "http://127.0.0.1:5174") {
    response.setHeader("access-control-allow-origin", origin);
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

app.get("/fragment", async (request, response, next) => {
  try {
    const module = await vite.ssrLoadModule("/src/fragment.marko") as {
      default: {
        render(input: Record<string, unknown>): NodeJS.ReadableStream;
      };
    };
    const version = Math.max(1, Number(request.query.version) || 1);
    const delay = Math.min(4_000, Math.max(0, Number(request.query.delay) || 700));
    const requestedInitialDelay = Number(request.query.initialDelay);
    const initialDelay = Number.isFinite(requestedInitialDelay)
      ? Math.min(4_000, Math.max(0, requestedInitialDelay))
      : 0;

    response.status(200);
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.flushHeaders();
    if (initialDelay) {
      await new Promise((resolve) => setTimeout(resolve, initialDelay));
    }

    const output = new PassThrough();
    output.pipe(response, { end: false });
    output.on("end", () => {
      response.end(
        '<script type="module" src="http://127.0.0.1:5175/src/client.ts"></script>',
      );
    });
    module.default.render({ version, delay }).pipe(output);
  } catch (error) {
    vite.ssrFixStacktrace(error as Error);
    next(error);
  }
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, app: "marko-fragment-server" });
});

app.use(vite.middlewares);

const port = 5175;
app.listen(port, "127.0.0.1", () => {
  console.log(`Marko fragment playground: http://127.0.0.1:${port}/fragment`);
});
