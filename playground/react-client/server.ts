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
    const templatePath = path.join(root, "index.html");
    const source = await fs.readFile(templatePath, "utf8");
    const template = await vite.transformIndexHtml(request.originalUrl, source);
    const [head, tail] = template.split("<!--app-html-->");
    if (head === undefined || tail === undefined) {
      throw new Error("SSR placeholder is missing from index.html.");
    }

    const entry = await vite.ssrLoadModule("/src/entry-server.tsx") as typeof import("./src/entry-server");
    await entry.render(request.originalUrl, response, head, tail);
  } catch (error) {
    vite.ssrFixStacktrace(error as Error);
    next(error);
  }
});

const port = 5173;
app.listen(port, "127.0.0.1", () => {
  console.log(`React host playground: http://127.0.0.1:${port}`);
});
