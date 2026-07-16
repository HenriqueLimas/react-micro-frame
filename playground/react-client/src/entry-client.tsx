import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { MicroFrameProvider } from "react-micro-frame";
import { createMicroFrameClientRuntime } from "react-micro-frame/client";
import { App } from "./App";

const runtime = createMicroFrameClientRuntime({
  allowedOrigins: [
    window.location.origin,
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
  ],
});

hydrateRoot(
  document.getElementById("root")!,
  <StrictMode>
    <MicroFrameProvider runtime={runtime}>
      <App mode="React host: SSR + hydration" />
    </MicroFrameProvider>
  </StrictMode>,
  { identifierPrefix: "playground-" },
);
