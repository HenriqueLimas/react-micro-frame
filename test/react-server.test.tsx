import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MicroFrame, MicroFrameProvider } from "../src";
import { createMicroFrameServerRuntime } from "../src/server";

async function readStream(stream: PassThrough): Promise<string> {
  let result = "";
  for await (const chunk of stream) result += chunk.toString();
  return result;
}

describe("React server integration", () => {
  it("uses Suspense for loading while composing progressive HTML", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      fetch: async () => new Response("<article>embedded</article>"),
      nonce: "nonce",
    });

    const rendered = renderToPipeableStream(
      <MicroFrameProvider runtime={runtime}>
        <main>
          <span>before</span>
          <MicroFrame src="/remote" loading={<b>loading</b>} />
          <span>after</span>
        </main>
      </MicroFrameProvider>,
      { nonce: "nonce" },
    );
    const destination = new PassThrough();
    const output = readStream(destination);

    await runtime.pipe(rendered, destination);
    const html = await output;

    expect(html).toContain("<b>loading</b>");
    expect(html).toContain("<article>embedded</article>");
    expect(html).toContain('data-micro-frame-generation="0"');
    expect(html.indexOf("embedded")).toBeLessThan(html.lastIndexOf("after"));
    expect(html).toContain("react-micro-frame:settled");
  });
});
