import fs from "node:fs/promises";
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
    hmr: { port: 24679, clientPort: 24679 },
  },
});

app.get("/health", async (_request, response) => {
  try {
    const dependencies = await Promise.all([
      fetch("http://127.0.0.1:5174/health"),
      fetch("http://127.0.0.1:5175/health"),
    ]);
    if (dependencies.every((dependency) => dependency.ok)) {
      response.json({ ok: true, app: "react-host" });
    } else {
      response.status(503).json({ ok: false });
    }
  } catch {
    response.status(503).json({ ok: false });
  }
});

app.use(vite.middlewares);
app.use(async (request, response, next) => {
  try {
    const nonce = new URL(
      request.originalUrl,
      "http://127.0.0.1:5173",
    ).searchParams.get("integration") === "csp"
      ? "browser-integration-nonce"
      : undefined;
    if (nonce) {
      response.setHeader(
        "content-security-policy",
        `default-src 'none'; base-uri 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*`,
      );
    }

    const templatePath = path.join(root, "index.html");
    const source = await fs.readFile(templatePath, "utf8");
    let template = await vite.transformIndexHtml(request.originalUrl, source);
    if (nonce) {
      template = template.replaceAll(
        /<script(?![^>]*\snonce(?:\s|=|>))/g,
        `<script nonce="${nonce}"`,
      );
    }
    const [head, tail] = template.split("<!--app-html-->");
    if (head === undefined || tail === undefined) {
      throw new Error("SSR placeholder is missing from index.html.");
    }

    const entry = await vite.ssrLoadModule("/src/entry-server.tsx") as typeof import("./src/entry-server");
    await entry.render(request.originalUrl, response, head, tail, nonce);
  } catch (error) {
    vite.ssrFixStacktrace(error as Error);
    next(error);
  }
});

const port = 5173;
app.listen(port, "127.0.0.1", () => {
  console.log(`React host playground: http://127.0.0.1:${port}`);
});
