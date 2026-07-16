import { useState } from "react";
import { MicroFrame } from "react-micro-frame";

export type BrowserIntegrationScenario =
  | "active-hydration"
  | "blocking-script"
  | "blocking-style"
  | "csp"
  | "preload";

export function getBrowserIntegrationScenario(
  url: string,
): BrowserIntegrationScenario | undefined {
  const scenario = new URL(url, "http://127.0.0.1:5173").searchParams.get(
    "integration",
  );
  return scenario === "active-hydration" ||
      scenario === "blocking-script" ||
      scenario === "blocking-style" ||
      scenario === "csp" ||
      scenario === "preload"
    ? scenario
    : undefined;
}

export function BrowserIntegrationApp({
  scenario,
}: {
  scenario: BrowserIntegrationScenario;
}) {
  const [version, setVersion] = useState(1);
  const [hydrationConfirmed, setHydrationConfirmed] = useState(false);

  return (
    <main>
      <h1>Browser integration: {scenario}</h1>
      <button type="button" onClick={() => setVersion((value) => value + 1)}>
        Reload fixture
      </button>
      <button type="button" onClick={() => setHydrationConfirmed(true)}>
        Confirm hydration
      </button>
      <output data-hydration-confirmed>
        {hydrationConfirmed ? "Hydrated" : "Waiting"}
      </output>
      <MicroFrame
        src={`http://127.0.0.1:5174/integration/${scenario}?version=${version}`}
        timeout={5_000}
        loading={<p>Loading fixture…</p>}
        error={(error) => <p role="alert">{error.message}</p>}
      />
    </main>
  );
}
