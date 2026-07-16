import { useState } from "react";
import { MicroFrame } from "react-micro-frame";

export type BrowserIntegrationScenario = "blocking-script";

export function getBrowserIntegrationScenario(
  url: string,
): BrowserIntegrationScenario | undefined {
  const scenario = new URL(url, "http://127.0.0.1:5173").searchParams.get(
    "integration",
  );
  return scenario === "blocking-script" ? scenario : undefined;
}

export function BrowserIntegrationApp({
  scenario,
}: {
  scenario: BrowserIntegrationScenario;
}) {
  const [version, setVersion] = useState(1);

  return (
    <main>
      <h1>Browser integration: {scenario}</h1>
      <button type="button" onClick={() => setVersion((value) => value + 1)}>
        Reload fixture
      </button>
      <MicroFrame
        src={`http://127.0.0.1:5174/integration/${scenario}?version=${version}`}
        timeout={5_000}
        loading={<p>Loading fixture…</p>}
        error={(error) => <p role="alert">{error.message}</p>}
      />
    </main>
  );
}
