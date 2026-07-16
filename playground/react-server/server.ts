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

app.get("/fragment", async (request, response, next) => {
  try {
    const module = await vite.ssrLoadModule("/src/fragment.tsx") as typeof import("./src/fragment");
    const version = Math.max(1, Number(request.query.version) || 1);
    const delay = Math.min(4_000, Math.max(0, Number(request.query.delay) || 450));

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
