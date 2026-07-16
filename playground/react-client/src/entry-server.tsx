import { PassThrough } from "node:stream";
import type { Response as ExpressResponse } from "express";
import { renderToPipeableStream } from "react-dom/server";
import { MicroFrameProvider } from "react-micro-frame";
import { createMicroFrameServerRuntime } from "react-micro-frame/server";
import { App } from "./App";
import {
  BrowserIntegrationApp,
  getBrowserIntegrationScenario,
} from "./BrowserIntegrationApp";

const reactFragmentOrigin = "http://127.0.0.1:5174";
const markoFragmentOrigin = "http://127.0.0.1:5175";

export function render(
  _url: string,
  response: ExpressResponse,
  head: string,
  tail: string,
): Promise<void> {
  const scenario = getBrowserIntegrationScenario(_url);
  const runtime = createMicroFrameServerRuntime({
    origin: "http://127.0.0.1:5173",
    composition: scenario === "active-hydration" ? "in-order" : "parallel",
    allowedOrigins: [
      "http://127.0.0.1:5173",
      reactFragmentOrigin,
      markoFragmentOrigin,
    ],
  });

  return new Promise((resolve, reject) => {
    let started = false;
    const rendered = renderToPipeableStream(
      <MicroFrameProvider runtime={runtime}>
        {scenario ? (
          <BrowserIntegrationApp scenario={scenario} />
        ) : (
          <App mode="React host: SSR + hydration" />
        )}
      </MicroFrameProvider>,
      {
        identifierPrefix: "playground-",
        onShellReady() {
          started = true;
          response.status(200);
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.write(head);

          const composed = new PassThrough();
          composed.pipe(response, { end: false });
          void runtime.pipe(rendered, composed).then(
            () => {
              response.end(tail);
              resolve();
            },
            (error) => {
              response.destroy(error as Error);
              reject(error);
            },
          );
        },
        onShellError(error) {
          runtime.abort(error);
          if (!started) response.status(500).end("Unable to render React shell.");
          reject(error);
        },
        onError(error) {
          console.error("React SSR error:", error);
        },
      },
    );

    response.on("close", () => {
      if (!response.writableEnded) runtime.abort();
    });
  });
}
