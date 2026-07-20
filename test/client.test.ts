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
    const fetch = vi.fn(
      async () =>
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
    expect(host.dataset.microFrameGeneration).toBe("0");
    expect(fetch).toHaveBeenCalledOnce();
    detach();
  });

  it("hides the loading fallback when the first chunk is inserted", async () => {
    const runtime = createMicroFrameClientRuntime({
      fetch: async () => new Response("<p>first</p>"),
    });
    const handle = runtime.prepare({ id: "frame", src: "/remote" });
    const host = createHost("frame", "/remote", "idle");
    const shell = document.createElement("div");
    const loading = document.createElement("div");
    loading.dataset.microFrameLoading = "frame";
    shell.append(loading, host);
    document.body.appendChild(shell);

    runtime.attach(handle, host);
    await handle.started;

    expect(host.textContent).toBe("first");
    expect(loading.style.display).toBe("none");
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
    host.insertBefore(
      document.createTextNode("server content"),
      host.lastChild,
    );

    runtime.attach(handle, host);
    await expect(handle.started).resolves.toBeUndefined();
    await handle.completed;

    expect(host.textContent).toBe("server content");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects responses redirected to a disallowed origin", async () => {
    let requestInit: RequestInit | undefined;
    const runtime = createMicroFrameClientRuntime({
      fetch: async (_url, init) => {
        requestInit = init;
        const response = new Response("<p>untrusted</p>");
        Object.defineProperty(response, "url", {
          value: "https://untrusted.test/payload",
        });
        return response;
      },
    });
    const handle = runtime.prepare({ id: "frame", src: "/redirect" });
    const host = createHost("frame", "/redirect", "idle");

    runtime.attach(handle, host);

    await expect(handle.started).rejects.toThrow("origin is not allowed");
    await expect(handle.completed).rejects.toThrow("origin is not allowed");
    expect(requestInit?.redirect).toBe("error");
    expect(host.textContent).toBe("");
    expect(host.dataset.microFrameState).toBe("error");
  });

  it("clears partial content and rejects on HTTP errors", async () => {
    const runtime = createMicroFrameClientRuntime({
      fetch: async () =>
        new Response("missing", { status: 404, statusText: "Not Found" }),
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

  it("reuses equivalent preparations and increments generations for changed requests", () => {
    const fetch = vi.fn();
    const runtime = createMicroFrameClientRuntime();
    const base = {
      id: "frame",
      src: "/remote",
      headers: { authorization: "token" },
      cache: "no-cache" as RequestCache,
      timeout: 100,
      fetch,
    };
    const first = runtime.prepare(base);

    expect(
      runtime.prepare({ ...base, headers: { authorization: "token" } }),
    ).toBe(first);
    const simple = runtime.prepare({ id: "simple", src: "/simple" });
    expect(runtime.prepare({ id: "simple", src: "/simple" })).toBe(simple);

    const changes = [
      { src: "/other" },
      { cache: "reload" as RequestCache },
      { timeout: 200 },
      { fetch: vi.fn() },
      { headers: { authorization: "other" } },
    ];
    changes.forEach((change, index) => {
      const handle = runtime.prepare({ ...base, ...change });
      expect(handle).not.toBe(first);
      expect(handle.generation).toBe(index + 1);
    });
  });

  it("adopts an in-flight server frame and follows its lifecycle events", async () => {
    const runtime = createMicroFrameClientRuntime({ fetch: vi.fn() });
    const handle = runtime.prepare({ id: "frame", src: "/remote" });
    const host = createHost("frame", "/remote", "loading");
    const detach = runtime.attach(handle, host);

    host.dataset.microFrameState = "streaming";
    host.dispatchEvent(new CustomEvent("react-micro-frame:started"));
    await expect(handle.started).resolves.toBeUndefined();

    host.dataset.microFrameState = "complete";
    host.dispatchEvent(new CustomEvent("react-micro-frame:settled"));
    await expect(handle.completed).resolves.toBeUndefined();

    detach();
    detach();
  });

  it("adopts failed server frames with their reported error", async () => {
    const runtime = createMicroFrameClientRuntime({ fetch: vi.fn() });
    const settled = runtime.prepare({ id: "settled", src: "/settled" });
    const settledHost = createHost("settled", "/settled", "error");
    settledHost.dataset.microFrameError = "render failed";
    runtime.attach(settled, settledHost);

    await expect(settled.started).rejects.toThrow("render failed");
    await expect(settled.completed).rejects.toThrow("render failed");

    const defaultError = runtime.prepare({ id: "default", src: "/default" });
    runtime.attach(defaultError, createHost("default", "/default", "error"));
    await expect(defaultError.completed).rejects.toThrow(
      "Server micro-frame failed",
    );

    const streaming = runtime.prepare({ id: "streaming", src: "/streaming" });
    const streamingHost = createHost("streaming", "/streaming", "streaming");
    runtime.attach(streaming, streamingHost);
    await expect(streaming.started).resolves.toBeUndefined();
    streamingHost.dataset.microFrameState = "error";
    streamingHost.dispatchEvent(new CustomEvent("react-micro-frame:settled"));
    await expect(streaming.completed).rejects.toThrow(
      "Server micro-frame failed",
    );
  });

  it("defers detach cleanup so an immediate reattachment keeps one request", async () => {
    const response = new Promise<Response>(() => undefined);
    const fetch = vi.fn(async () => response);
    const runtime = createMicroFrameClientRuntime({ fetch });
    const handle = runtime.prepare({ id: "frame", src: "/remote" });
    const host = createHost("frame", "/remote", "idle");

    const firstDetach = runtime.attach(handle, host);
    firstDetach();
    const secondDetach = runtime.attach(handle, host);
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(host.dataset.microFrameState).toBe("loading");
    secondDetach();
    await Promise.resolve();
    await expect(handle.completed).resolves.toBeUndefined();
  });

  it("stops superseded frames and all active frames when the runtime aborts", async () => {
    const fetch = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const runtime = createMicroFrameClientRuntime({ fetch });
    const first = runtime.prepare({ id: "frame", src: "/first" });
    runtime.attach(first, createHost("frame", "/first", "idle"));
    const second = runtime.prepare({ id: "frame", src: "/second" });
    runtime.attach(second, createHost("frame", "/second", "idle"));

    await expect(first.started).resolves.toBeUndefined();
    await expect(first.completed).resolves.toBeUndefined();
    runtime.abort();
    runtime.abort();
    await expect(second.started).resolves.toBeUndefined();
    await expect(second.completed).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("forwards request options and supports explicitly allowed origins", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const runtime = createMicroFrameClientRuntime({
      allowedOrigins: [new URL("https://remote.test")],
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return new Response("");
      },
    });
    const handle = runtime.prepare({
      id: "frame",
      src: "https://remote.test/content",
      headers: { "x-frame": "yes" },
      cache: "reload",
      timeout: 0,
    });
    runtime.attach(
      handle,
      createHost("frame", "https://remote.test/content", "idle"),
    );

    await handle.completed;
    expect(requestUrl).toBe("https://remote.test/content");
    expect(new Headers(requestInit?.headers).get("x-frame")).toBe("yes");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("text/html");
    expect(requestInit?.cache).toBe("reload");
    expect(requestInit?.redirect).toBe("error");
  });

  it("uses global fetch and rejects disallowed request origins before fetching", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(""));
    const runtime = createMicroFrameClientRuntime();
    const allowed = runtime.prepare({ id: "allowed", src: "/allowed" });
    runtime.attach(allowed, createHost("allowed", "/allowed", "idle"));
    await allowed.completed;

    const blocked = runtime.prepare({
      id: "blocked",
      src: "https://untrusted.test/content",
    });
    runtime.attach(
      blocked,
      createHost("blocked", "https://untrusted.test/content", "idle"),
    );
    await expect(blocked.completed).rejects.toThrow("origin is not allowed");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects responses without a streaming body and non-Error failures", async () => {
    const noBodyRuntime = createMicroFrameClientRuntime({
      fetch: async () => new Response(null, { status: 204 }),
    });
    const noBody = noBodyRuntime.prepare({ id: "body", src: "/body" });
    noBodyRuntime.attach(noBody, createHost("body", "/body", "idle"));
    await expect(noBody.completed).rejects.toThrow("body is not a stream");

    const failureRuntime = createMicroFrameClientRuntime({
      fetch: async () => {
        throw "offline";
      },
    });
    const failure = failureRuntime.prepare({ id: "failure", src: "/failure" });
    failureRuntime.attach(failure, createHost("failure", "/failure", "idle"));
    await expect(failure.completed).rejects.toThrow("offline");
  });

  it("times out requests using the configured default", async () => {
    const runtime = createMicroFrameClientRuntime({
      defaultTimeout: 5,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    });
    const handle = runtime.prepare({ id: "frame", src: "/slow" });
    runtime.attach(handle, createHost("frame", "/slow", "idle"));

    await expect(handle.completed).rejects.toThrow("timed out after 5ms");
  });

  it("reports missing host markers", async () => {
    const runtime = createMicroFrameClientRuntime({
      fetch: async () => new Response("content"),
    });
    const handle = runtime.prepare({ id: "frame", src: "/remote" });
    const host = document.createElement("div");
    document.body.appendChild(host);

    runtime.attach(handle, host);
    await expect(handle.started).rejects.toThrow("host markers are missing");
    await expect(handle.completed).rejects.toThrow("host markers are missing");
    expect(host.dataset.microFrameState).toBe("error");
  });
});
