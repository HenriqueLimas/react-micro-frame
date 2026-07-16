import type { Writable } from "node:stream";
import { Suspense } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { Counter } from "./Counter";

interface FragmentInput {
  version: number;
  delay: number;
}

async function DelayedChunk({ version, delay }: FragmentInput) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return (
    <div data-stream-complete>
      <p>The delayed React chunk arrived after {delay}ms.</p>
      <div data-react-counter-root data-version={version}>
        <Counter />
      </div>
    </div>
  );
}

function ReactFragment(input: FragmentInput) {
  return (
    <article className="react-card" data-react-fragment data-version={input.version}>
      <style>{`
        .react-card {
          position: relative;
          overflow: hidden;
          border: 1px solid #b7c4ff;
          border-radius: 16px;
          padding: 24px;
          color: #222b59;
          background: linear-gradient(135deg, #f2f4ff, #e3e8ff);
          box-shadow: inset 4px 0 #5b6ee1;
        }
        .react-card::after {
          content: "REACT";
          position: absolute;
          top: 14px;
          right: 18px;
          color: #4859c7;
          font-size: 0.72rem;
          font-weight: 900;
          letter-spacing: 0.14em;
        }
        .react-card h3 { margin: 0 0 8px; font-size: 1.45rem; }
        .react-card p { margin: 8px 0; }
        .react-card .chunk { color: #58638f; }
        .react-card button {
          margin-top: 10px;
          border: 0;
          border-radius: 999px;
          padding: 8px 13px;
          color: white;
          background: #4859c7;
          cursor: pointer;
        }
        .react-card .counter { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
        .react-card .counter button { margin-top: 0; min-width: 36px; }
        .react-card output { min-width: 2ch; text-align: center; font-size: 1.15rem; font-weight: 800; }
      `}</style>
      <h3>Remote React fragment v{input.version}</h3>
      <p className="chunk" data-first-chunk>
        This heading and stylesheet arrived in the first React response chunk.
      </p>
      <Suspense fallback={<p data-fragment-pending>React server is preparing its delayed chunk…</p>}>
        <DelayedChunk {...input} />
      </Suspense>
      <script
        type="module"
        src="http://127.0.0.1:5174/src/client.tsx"
        crossOrigin="anonymous"
      />
    </article>
  );
}

export function renderFragment(
  input: FragmentInput,
  destination: Writable,
) {
  let rendered: ReturnType<typeof renderToPipeableStream>;
  rendered = renderToPipeableStream(<ReactFragment {...input} />, {
    onShellReady() {
      rendered.pipe(destination);
    },
    onShellError(error) {
      destination.destroy(error as Error);
    },
    onError(error) {
      console.error("React fragment render error:", error);
    },
  });
  return rendered;
}
