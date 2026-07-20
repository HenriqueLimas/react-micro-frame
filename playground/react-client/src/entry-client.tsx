import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { MicroFrameProvider } from "@micro-frame/react";
import { createMicroFrameClientRuntime } from "@micro-frame/react/client";
import { App } from "./App";
import {
  BrowserIntegrationApp,
  getBrowserIntegrationScenario,
} from "./BrowserIntegrationApp";

const scenario = getBrowserIntegrationScenario(window.location.href);
const runtime = createMicroFrameClientRuntime({
  allowedOrigins: [
    window.location.origin,
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
  ],
});

hydrateWhenShellIsReady();

function hydrateWhenShellIsReady(): void {
  const root = document.getElementById("root");
  if (!root || !root.firstChild) {
    requestAnimationFrame(hydrateWhenShellIsReady);
    return;
  }

  hydrateRoot(
    root,
    <StrictMode>
      <MicroFrameProvider runtime={runtime}>
        {scenario ? (
          <BrowserIntegrationApp scenario={scenario} />
        ) : (
          <App mode="React host: SSR + hydration" />
        )}
      </MicroFrameProvider>
    </StrictMode>,
    { identifierPrefix: "playground-" },
  );
}
