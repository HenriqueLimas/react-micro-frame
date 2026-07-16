import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createMicroFrameServerRuntime,
  type MicroFrameServerRuntime,
} from "../src/server";
import { endMarker, startMarker } from "../src/dom-markers";

async function collect(
  iterable: AsyncIterable<Uint8Array | string>,
): Promise<string> {
  const decoder = new TextDecoder();
  let result = "";
  for await (const chunk of iterable) {
    result += typeof chunk === "string"
      ? chunk
      : decoder.decode(chunk, { stream: true });
  }
  return result + decoder.decode();
}

function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/html" } },
  );
}

function register(runtime: MicroFrameServerRuntime, id = "frame") {
  return runtime.prepare({ id, src: "/remote" });
}

describe("server stream composition", () => {
  it("inserts remote bytes between markers and preserves host order", async () => {
    const fetch = vi.fn(async () => streamedResponse(["<h1>Hel", "lo</h1>"]));
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test/page",
      fetch,
      nonce: "test-nonce",
    });
    const handle = register(runtime);

    async function* reactOutput() {
      const output = `<main>before${startMarker("frame")}${endMarker("frame")}after</main>`;
      const split = output.indexOf("frame:start") + 3;
      yield output.slice(0, split);
      yield output.slice(split);
    }

    const html = await collect(runtime.compose(reactOutput()));
    await expect(handle.started).resolves.toBeUndefined();
    await expect(handle.completed).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledOnce();
    expect(html.indexOf("before")).toBeLessThan(html.indexOf("<h1>Hello</h1>"));
    expect(html.indexOf("<h1>Hello</h1>")).toBeLessThan(html.indexOf("after"));
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain('h.dataset.microFrameState="complete"');
  });

  it("rejects disallowed origins without making a request", async () => {
    const fetch = vi.fn(async () => streamedResponse(["never"]));
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      fetch,
    });
    const handle = runtime.prepare({
      id: "frame",
      src: "https://untrusted.test/remote",
    });

    async function* reactOutput() {
      yield `${startMarker("frame")}${endMarker("frame")}`;
    }

    const html = await collect(runtime.compose(reactOutput()));
    await expect(handle.started).rejects.toThrow("origin is not allowed");
    await expect(handle.completed).rejects.toThrow("origin is not allowed");
    expect(fetch).not.toHaveBeenCalled();
    expect(html).toContain('h.dataset.microFrameState="error"');
    expect(html).toContain("while(s.nextSibling)s.nextSibling.remove()");
  });

  it("supports the normal React pipeable-stream contract", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      fetch: async () => streamedResponse(["<p>remote</p>"]),
    });
    register(runtime);

    const rendered = {
      pipe(destination: NodeJS.WritableStream) {
        destination.write(`shell${startMarker("frame")}`);
        destination.end(`${endMarker("frame")}footer`);
      },
    };
    const destination = new PassThrough();
    const output = collect(destination);

    await runtime.pipe(rendered, destination);
    expect(await output).toMatch(/shell.*<p>remote<\/p>.*footer/s);
  });
});
