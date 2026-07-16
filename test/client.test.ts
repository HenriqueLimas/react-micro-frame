import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMicroFrameClientRuntime } from "../src/client";
import { decodeReadableStream } from "../src/decode";
import { endMarker, startMarker } from "../src/dom-markers";

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://host.test/page",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent,
    DOMException: dom.window.DOMException,
  });
});

afterEach(() => dom.window.close());

function createHost(id: string, src: string, state: string): HTMLDivElement {
  const host = document.createElement("div");
  host.dataset.microFrameSrc = src;
  host.dataset.microFrameState = state;
  host.innerHTML = `${startMarker(id)}${endMarker(id)}`;
  document.body.appendChild(host);
  return host;
}

describe("client runtime", () => {
  it("streams HTML into the opaque region", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("<span>first</span><p>héllo</p>"),
            );
            controller.close();
          },
        }),
      ),
    );
    const runtime = createMicroFrameClientRuntime({ fetch });
    const handle = runtime.prepare({ id: "frame", src: "/remote" });
    const host = createHost("frame", "/remote", "idle");

    const detach = runtime.attach(handle, host);
    await expect(handle.started).resolves.toBeUndefined();
    await handle.completed;

    expect(host.textContent).toBe("firsthéllo");
    expect(host.querySelector("p")?.textContent).toBe("héllo");
    expect(host.dataset.microFrameState).toBe("complete");
    expect(fetch).toHaveBeenCalledOnce();
    detach();
  });

  it("preserves UTF-8 characters split across network chunks", async () => {
    const encoded = new TextEncoder().encode("héllo");
    const split = encoded.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    });
    let decoded = "";
    for await (const chunk of decodeReadableStream(stream)) decoded += chunk;
    expect(decoded).toBe("héllo");
  });

  it("adopts completed server content without fetching again", async () => {
    const fetch = vi.fn();
    const runtime = createMicroFrameClientRuntime({ fetch });
    const handle = runtime.prepare({ id: "frame", src: "/remote" });
    const host = createHost("frame", "/remote", "complete");
    host.insertBefore(document.createTextNode("server content"), host.lastChild);

    runtime.attach(handle, host);
    await expect(handle.started).resolves.toBeUndefined();
    await handle.completed;

    expect(host.textContent).toBe("server content");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears partial content and rejects on HTTP errors", async () => {
    const runtime = createMicroFrameClientRuntime({
      fetch: async () => new Response("missing", { status: 404, statusText: "Not Found" }),
    });
    const handle = runtime.prepare({ id: "frame", src: "/missing" });
    const host = createHost("frame", "/missing", "idle");
    host.insertBefore(document.createTextNode("stale"), host.lastChild);

    runtime.attach(handle, host);

    await expect(handle.started).rejects.toThrow("404 Not Found");
    await expect(handle.completed).rejects.toThrow("404 Not Found");
    expect(host.textContent).toBe("");
    expect(host.dataset.microFrameState).toBe("error");
  });
});
