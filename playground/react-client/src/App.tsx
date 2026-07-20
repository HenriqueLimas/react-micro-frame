import { useState } from "react";
import { MicroFrame } from "react-micro-frame";

const reactFragmentOrigin = "http://127.0.0.1:5174";
const markoFragmentOrigin = "http://127.0.0.1:5175";

export function App({ mode }: { mode: string }) {
  const [version, setVersion] = useState(1);
  const [visible, setVisible] = useState(true);

  return (
    <main className="page">
      <header className="hero">
        <span className="eyebrow">react-micro-frame playground</span>
        <h1>{mode}</h1>
        <p>
          This React application owns the page. It server-renders, hydrates, and
          embeds independent fragments produced by React and Marko servers.
        </p>
      </header>

      <nav className="controls" aria-label="Micro-frame controls">
        <button type="button" onClick={() => setVersion((value) => value + 1)}>
          Reload fragments
        </button>
        <button type="button" onClick={() => setVisible((value) => !value)}>
          {visible ? "Unmount fragments" : "Mount fragments"}
        </button>
        <output>Requested version: {version}</output>
      </nav>

      <section className="host-panel">
        <h2>React-hosted micro-frames</h2>
        {visible ? (
          <div className="frame-grid">
            <section data-provider="react">
              <h3>Provided by the React server</h3>
              <MicroFrame
                className="frame-shell"
                src={`${reactFragmentOrigin}/fragment?version=${version}&delay=450`}
                timeout={5_000}
                loading={
                  <div className="loading" role="status">
                    Streaming React fragment…
                  </div>
                }
                error={(error) => (
                  <div className="error" role="alert">
                    {error.message}
                  </div>
                )}
              />
            </section>

            <section data-provider="marko">
              <h3>Provided by the Marko server</h3>
              <MicroFrame
                className="frame-shell"
                src={`${markoFragmentOrigin}/fragment?version=${version}&initialDelay=650&delay=700`}
                timeout={5_000}
                loading={
                  <div className="loading" role="status">
                    Streaming Marko fragment…
                  </div>
                }
                error={(error) => (
                  <div className="error" role="alert">
                    {error.message}
                  </div>
                )}
              />
            </section>
          </div>
        ) : (
          <div className="empty">Both micro-frames are unmounted.</div>
        )}
        <p className="after-frame">
          This content remains owned by the hydrated React host.
        </p>
      </section>
    </main>
  );
}
