import { PassThrough, Writable } from "node:stream";
import { JSDOM } from "jsdom";
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
    result +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
  }
  return result + decoder.decode();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  it.each(["in-order", "parallel"] as const)(
    "preserves ordering when %s source chunks mix bytes and strings",
    async (composition) => {
      const runtime = createMicroFrameServerRuntime({
        origin: "https://host.test",
        composition,
      });

      async function* reactOutput() {
        yield Uint8Array.of(0xc3);
        yield "between";
        yield Uint8Array.of(0xa9);
      }

      await expect(collect(runtime.compose(reactOutput()))).resolves.toBe(
        "\uFFFDbetween\uFFFD",
      );
    },
  );

  it("delivers completed frames without waiting for slower frames in parallel mode", async () => {
    const streams = new Map<
      string,
      ReadableStreamDefaultController<Uint8Array>
    >();
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(new URL(url).pathname, controller);
            },
          }),
        ),
    );
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      fetch,
      composition: "parallel",
      nonce: "test-nonce",
    });
    const slow = runtime.prepare({ id: "slow", src: "/slow" });
    const fast = runtime.prepare({ id: "fast", src: "/fast" });
    const finishReact = deferred<void>();
    const output: string[] = [];

    async function* reactOutput() {
      yield `<main><div id="react-micro-frame-slow" data-micro-frame-src="/slow" data-micro-frame-generation="0">${startMarker("slow")}${endMarker("slow")}</div><div id="react-micro-frame-fast" data-micro-frame-src="/fast" data-micro-frame-generation="0">${startMarker("fast")}${endMarker("fast")}</div><footer>shell</footer>`;
      await finishReact.promise;
      yield "</main>";
    }

    const composing = (async () => {
      for await (const chunk of runtime.compose(reactOutput())) {
        output.push(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
        );
      }
    })();

    await vi.waitFor(() => expect(streams.size).toBe(2));
    streams.get("/fast")!.enqueue(new TextEncoder().encode("<p>fast</p>"));
    streams.get("/fast")!.close();

    await vi.waitFor(() => expect(output.join("")).toContain("<p>fast</p>"));
    expect(output.join("")).toContain("<footer>shell</footer>");
    expect(output.join("")).not.toContain("<p>slow</p>");
    await expect(fast.completed).resolves.toBeUndefined();

    streams.get("/slow")!.enqueue(new TextEncoder().encode("<p>slow</p>"));
    streams.get("/slow")!.close();
    finishReact.resolve(undefined);
    await composing;
    await expect(slow.completed).resolves.toBeUndefined();

    const html = output.join("");
    expect(html.indexOf("<p>fast</p>")).toBeLessThan(
      html.indexOf("<p>slow</p>"),
    );
    expect(html).toContain('style="display:none!important"');
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain("document.createDocumentFragment()");

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    expect(
      dom.window.document.querySelector("#react-micro-frame-fast p")
        ?.textContent,
    ).toBe("fast");
    expect(
      dom.window.document.querySelector("#react-micro-frame-slow p")
        ?.textContent,
    ).toBe("slow");
    expect(
      dom.window.document.querySelector("[id^=react-micro-frame-payload-]"),
    ).toBeNull();
    expect(dom.window.document.querySelector("script")).toBeNull();
    dom.window.close();
  });

  it("executes scripts after accepting a parallel payload generation", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      fetch: async () =>
        streamedResponse([
          "<script>window.acceptedPayloadExecuted=true</script><p>remote</p>",
        ]),
    });
    runtime.prepare({ id: "frame", src: "/remote" });

    async function* reactOutput() {
      yield `<div id="react-micro-frame-frame" data-micro-frame-src="/remote" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div>`;
    }

    const html = await collect(runtime.compose(reactOutput()));
    const dom = new JSDOM(html, { runScripts: "dangerously" });

    expect(
      (dom.window as unknown as { acceptedPayloadExecuted?: boolean })
        .acceptedPayloadExecuted,
    ).toBe(true);
    expect(
      dom.window.document.querySelector("#react-micro-frame-frame p")
        ?.textContent,
    ).toBe("remote");
    dom.window.close();
  });

  it("uses TrustedHTML to activate a parallel payload when Trusted Types are enforced", async () => {
    const policyNames: string[] = [];
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      trustedTypesPolicyName: "micro-frame-test",
      fetch: async () => streamedResponse(['<p id="remote">remote</p>']),
    });
    runtime.prepare({ id: "frame", src: "/remote" });

    async function* reactOutput() {
      yield `<div id="react-micro-frame-frame" data-micro-frame-src="/remote" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div>`;
    }

    const html = await collect(runtime.compose(reactOutput()));
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window) {
        const originalWrite = window.document.write.bind(window.document);
        class TrustedHTMLValue {
          constructor(readonly value: string) {}
          toString() {
            return this.value;
          }
        }
        Object.defineProperty(window, "trustedTypes", {
          value: {
            createPolicy(
              name: string,
              rules: { createHTML(value: string): string },
            ) {
              policyNames.push(name);
              return {
                createHTML(value: string) {
                  return new TrustedHTMLValue(rules.createHTML(value));
                },
              };
            },
          },
        });
        window.document.write = ((value: string | TrustedHTMLValue) => {
          if (!(value instanceof TrustedHTMLValue)) {
            throw new TypeError("TrustedHTML required");
          }
          originalWrite(value.toString());
        }) as typeof window.document.write;
      },
    });

    expect(policyNames).toEqual(["micro-frame-test"]);
    expect(
      dom.window.document.querySelector("#react-micro-frame-frame #remote")
        ?.textContent,
    ).toBe("remote");
    expect(
      dom.window.document
        .querySelector("#react-micro-frame-frame")
        ?.getAttribute("data-micro-frame-state"),
    ).toBe("complete");
    dom.window.close();
  });

  it("keeps the loading state until a parallel payload is ready to emit", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
        ),
    });
    const handle = runtime.prepare({ id: "frame", src: "/remote" });
    const output: string[] = [];

    async function* reactOutput() {
      yield `<div id="react-micro-frame-frame" data-micro-frame-src="/remote" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div>`;
      await handle.started;
      yield "started-status";
      await handle.completed;
      yield "completed-status";
    }

    const composing = (async () => {
      for await (const chunk of runtime.compose(reactOutput())) {
        output.push(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
        );
      }
    })();

    stream.enqueue(new TextEncoder().encode("<p>remote</p>"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output.join("")).not.toContain("started-status");

    stream.close();
    await composing;

    const html = output.join("");
    expect(html.indexOf("<p>remote</p>")).toBeLessThan(
      html.indexOf("started-status"),
    );
    expect(html.indexOf("react-micro-frame:settled")).toBeLessThan(
      html.indexOf("completed-status"),
    );
  });

  it("waits to emit parallel payloads outside unsafe parser contexts", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      fetch: async () => streamedResponse(["<p>remote</p>"]),
    });
    runtime.prepare({ id: "frame", src: "/remote" });

    async function* reactOutput() {
      yield `<body><div id="react-micro-frame-frame" data-micro-frame-src="/remote" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div><iframe>fallback`;
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield "</iframe></body>";
    }

    const html = await collect(runtime.compose(reactOutput()));
    expect(html.indexOf("</iframe>")).toBeLessThan(
      html.indexOf("<p>remote</p>"),
    );

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    expect(
      dom.window.document.querySelector("#react-micro-frame-frame p")
        ?.textContent,
    ).toBe("remote");
    expect(dom.window.document.querySelector("iframe")?.textContent).toBe(
      "fallback",
    );
    dom.window.close();
  });

  it("recognizes raw-text closing tags with long whitespace", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      fetch: async () => streamedResponse(["<p>remote</p>"]),
    });
    runtime.prepare({ id: "frame", src: "/remote" });

    async function* reactOutput() {
      yield `<div id="react-micro-frame-frame" data-micro-frame-src="/remote" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div><script>window.shell=true</script${" ".repeat(256)}>`;
    }

    await expect(collect(runtime.compose(reactOutput()))).resolves.toContain(
      "<p>remote</p>",
    );
  });

  it("does not emit parallel payloads inside script double-escaped text", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      fetch: async () => streamedResponse(['<p id="remote">remote</p>']),
    });
    runtime.prepare({ id: "frame", src: "/remote" });

    async function* reactOutput() {
      yield `<div id="react-micro-frame-frame" data-micro-frame-src="/remote" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div><script>window.shellSnippet="<!--<script></script>`;
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield `-->";</script><p id="shell">shell</p>`;
    }

    const html = await collect(runtime.compose(reactOutput()));
    expect(html.indexOf('-->";</script>')).toBeLessThan(
      html.indexOf('<p id="remote">'),
    );

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    expect(
      (dom.window as unknown as { shellSnippet?: string }).shellSnippet,
    ).toBe("<!--<script></script>-->");
    expect(
      dom.window.document.querySelector("#react-micro-frame-frame #remote")
        ?.textContent,
    ).toBe("remote");
    dom.window.close();
  });

  it.each([
    {
      context: "form",
      open: '<form id="outer"><span id="cursor">',
      close: '</span><input id="outer-input"></form>',
      payload: '<form id="inner"><input id="inner-input"></form>',
    },
    {
      context: "anchor",
      open: '<a id="outer"><span id="cursor">',
      close: "</span></a>",
      payload: '<a id="inner">inner</a>',
    },
    {
      context: "button",
      open: '<button id="outer"><span id="cursor">',
      close: "</span></button>",
      payload: '<button id="inner">inner</button>',
    },
    {
      context: "heading",
      open: '<h1 id="outer"><span id="cursor">',
      close: "</span></h1>",
      payload: '<h2 id="inner">inner</h2>',
    },
    {
      context: "nobr",
      open: '<nobr id="outer"><span id="cursor">',
      close: "</span></nobr>",
      payload: '<nobr id="inner">inner</nobr>',
    },
    {
      context: "list item",
      open: '<ul><li id="outer"><span id="cursor">',
      close: "</span></li></ul>",
      payload: '<li id="inner">inner</li>',
    },
    {
      context: "definition term",
      open: '<dl><dt id="outer"><span id="cursor">',
      close: "</span></dt></dl>",
      payload: '<dd id="inner">inner</dd>',
    },
    {
      context: "definition description",
      open: '<dl><dd id="outer"><span id="cursor">',
      close: "</span></dd></dl>",
      payload: '<dt id="inner">inner</dt>',
    },
    {
      context: "table cell",
      open: '<table><tbody><tr><td id="outer"><span id="cursor">',
      close: "</span></td></tr></tbody></table>",
      payload: '</td><p id="inner">inner</p>',
    },
  ])(
    "waits to emit parallel payloads outside an open $context context",
    async ({ open, close, payload }) => {
      const runtime = createMicroFrameServerRuntime({
        origin: "https://host.test",
        composition: "parallel",
        fetch: async () => streamedResponse([payload]),
      });
      runtime.prepare({ id: "frame", src: "/remote" });

      async function* reactOutput() {
        yield `<body><div id="react-micro-frame-frame" data-micro-frame-src="/remote" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div>${open}`;
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield `${close}<div id="after"></div>`;
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield "</body>";
      }

      const html = await collect(runtime.compose(reactOutput()));
      expect(html.indexOf('id="after"')).toBeLessThan(
        html.indexOf('id="inner"'),
      );

      const dom = new JSDOM(html, { runScripts: "dangerously" });
      const document = dom.window.document;
      expect(
        document
          .getElementById("outer")
          ?.contains(document.getElementById("cursor")),
      ).toBe(true);
      expect(
        document
          .getElementById("react-micro-frame-frame")
          ?.contains(document.getElementById("inner")),
      ).toBe(true);
      if (document.getElementById("outer-input")) {
        expect(
          document
            .getElementById("outer")
            ?.contains(document.getElementById("outer-input")),
        ).toBe(true);
      }
      dom.window.close();
    },
  );

  it("discards a parallel payload when its host generation was replaced", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      fetch: async () =>
        streamedResponse([
          "<script>window.stalePayloadExecuted=true</script><p>stale</p>",
        ]),
    });
    runtime.prepare({ id: "frame", src: "/old" });

    async function* reactOutput() {
      yield `<body><div id="react-micro-frame-frame" data-micro-frame-src="/old" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div><script>document.getElementById("react-micro-frame-frame").outerHTML='<div id="react-micro-frame-frame" data-micro-frame-src="/new" data-micro-frame-generation="1"></div>'</script>`;
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield "</body>";
    }

    const html = await collect(runtime.compose(reactOutput()));
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      url: "https://host.test/",
    });
    const host = dom.window.document.getElementById("react-micro-frame-frame");

    expect(host?.dataset.microFrameSrc).toBe("/new");
    expect(host?.querySelector("p")).toBeNull();
    expect(
      (dom.window as unknown as { stalePayloadExecuted?: boolean })
        .stalePayloadExecuted,
    ).toBeUndefined();
    expect(
      dom.window.document.querySelector("[id^=react-micro-frame-payload-]"),
    ).toBeNull();
    expect(dom.window.document.querySelectorAll("script")).toHaveLength(1);
    dom.window.close();
  });

  it("settles in-order failures without removing host markers", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      fetch: async () =>
        new Response("missing", { status: 404, statusText: "Not Found" }),
    });
    const handle = runtime.prepare({ id: "frame", src: "/missing" });

    async function* reactOutput() {
      yield `<div id="react-micro-frame-frame">${startMarker("frame")}${endMarker("frame")}</div>`;
    }

    const html = await collect(runtime.compose(reactOutput()));
    await expect(handle.started).rejects.toThrow("404 Not Found");
    await expect(handle.completed).rejects.toThrow("404 Not Found");

    const dom = new JSDOM(html, { runScripts: "outside-only" });
    const script = dom.window.document.querySelector("script");
    dom.window.eval(script?.textContent ?? "");
    const host = dom.window.document.getElementById("react-micro-frame-frame");
    expect(host?.dataset.microFrameState).toBe("error");
    expect(
      [...(host?.childNodes ?? [])]
        .filter((node) => node.nodeType === dom.window.Node.COMMENT_NODE)
        .map((node) => node.nodeValue),
    ).toEqual(["react-micro-frame:frame:start", "react-micro-frame:frame:end"]);
    expect(dom.window.document.querySelector("script")).toBeNull();
    dom.window.close();
  });

  it("settles parallel failures and removes their transient script", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      fetch: async () =>
        new Response("missing", { status: 404, statusText: "Not Found" }),
    });
    const handle = runtime.prepare({ id: "frame", src: "/missing" });

    async function* reactOutput() {
      yield `<div id="react-micro-frame-frame" data-micro-frame-src="/missing" data-micro-frame-generation="0">${startMarker("frame")}${endMarker("frame")}</div>`;
    }

    const html = await collect(runtime.compose(reactOutput()));
    await expect(handle.started).rejects.toThrow("404 Not Found");
    await expect(handle.completed).rejects.toThrow("404 Not Found");

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const host = dom.window.document.getElementById("react-micro-frame-frame");
    expect(host?.dataset.microFrameState).toBe("error");
    expect(
      [...(host?.childNodes ?? [])]
        .filter((node) => node.nodeType === dom.window.Node.COMMENT_NODE)
        .map((node) => node.nodeValue),
    ).toEqual(["react-micro-frame:frame:start", "react-micro-frame:frame:end"]);
    expect(dom.window.document.querySelector("script")).toBeNull();
    dom.window.close();
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
    expect(html).toContain('n.data==="react-micro-frame:frame:end"');
  });

  it("rejects responses redirected to a disallowed origin", async () => {
    let requestInit: RequestInit | undefined;
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      fetch: async (_url, init) => {
        requestInit = init;
        const response = streamedResponse(["<p>untrusted</p>"]);
        Object.defineProperty(response, "url", {
          value: "https://untrusted.test/payload",
        });
        return response;
      },
    });
    const handle = register(runtime);

    async function* reactOutput() {
      yield `${startMarker("frame")}${endMarker("frame")}`;
    }

    const html = await collect(runtime.compose(reactOutput()));
    await expect(handle.started).rejects.toThrow("origin is not allowed");
    await expect(handle.completed).rejects.toThrow("origin is not allowed");
    expect(requestInit?.redirect).toBe("error");
    expect(html).not.toContain("<p>untrusted</p>");
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

  it("reuses registrations, rejects conflicts, and settles entries on abort", async () => {
    const fetch = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      fetch,
      defaultTimeout: 0,
    });
    const handle = register(runtime);

    expect(register(runtime)).toBe(handle);
    expect(() => runtime.prepare({ id: "frame", src: "/conflicting" })).toThrow(
      "Conflicting micro-frame registration",
    );

    runtime.abort();
    runtime.abort(new Error("ignored"));
    await expect(handle.started).rejects.toThrow("server runtime aborted");
    await expect(handle.completed).rejects.toThrow("server runtime aborted");
    expect(() => runtime.prepare({ id: "late", src: "/late" })).toThrow(
      "after the server runtime was aborted",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("forwards selected headers and lets request options override runtime defaults", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    let receivedDefaultFetch: typeof globalThis.fetch | undefined;
    const runtimeFetch = vi.fn();
    const requestFetch = vi.fn(async (url, init, defaultFetch) => {
      requestUrl = url;
      requestInit = init;
      receivedDefaultFetch = defaultFetch;
      return streamedResponse([]);
    });
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test/page",
      allowedOrigins: [new URL("https://remote.test")],
      requestHeaders: {
        cookie: "session=1",
        "x-forwarded": "incoming",
      },
      forwardHeaders: ["cookie", "x-missing", "x-forwarded"],
      fetch: runtimeFetch,
      defaultTimeout: 0,
    });
    const handle = runtime.prepare({
      id: "frame",
      src: "https://remote.test/content",
      headers: { "x-forwarded": "request", "x-local": "yes" },
      cache: "reload",
      timeout: 0,
      fetch: requestFetch,
    });

    async function* reactOutput() {
      yield `${startMarker("frame")}${endMarker("frame")}`;
    }

    await collect(runtime.compose(reactOutput()));
    await expect(handle.completed).resolves.toBeUndefined();
    const headers = new Headers(requestInit?.headers);
    expect(requestUrl).toBe("https://remote.test/content");
    expect(headers.get("cookie")).toBe("session=1");
    expect(headers.get("x-forwarded")).toBe("request");
    expect(headers.get("x-local")).toBe("yes");
    expect(headers.get("x-missing")).toBeNull();
    expect(headers.get("accept")).toBe("text/html");
    expect(requestInit?.cache).toBe("reload");
    expect(requestInit?.redirect).toBe("error");
    expect(receivedDefaultFetch).toBe(globalThis.fetch);
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("uses global fetch when no override is configured", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(streamedResponse(["global"]));
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      defaultTimeout: 0,
    });
    register(runtime);

    async function* reactOutput() {
      yield `${startMarker("frame")}${endMarker("frame")}`;
    }

    await expect(collect(runtime.compose(reactOutput()))).resolves.toContain(
      "global",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects bodyless responses and non-Error fetch failures", async () => {
    const cases = [
      {
        id: "bodyless",
        fetch: async () => new Response(null, { status: 204 }),
        message: "body is not a stream",
      },
      {
        id: "offline",
        fetch: async () => {
          throw "offline";
        },
        message: "offline",
      },
    ];

    for (const testCase of cases) {
      const runtime = createMicroFrameServerRuntime({
        origin: "https://host.test",
        fetch: testCase.fetch,
        defaultTimeout: 0,
      });
      const handle = runtime.prepare({ id: testCase.id, src: "/remote" });

      async function* reactOutput() {
        yield `${startMarker(testCase.id)}${endMarker(testCase.id)}`;
      }

      const html = await collect(runtime.compose(reactOutput()));
      await expect(handle.started).rejects.toThrow(testCase.message);
      await expect(handle.completed).rejects.toThrow(testCase.message);
      expect(html).toContain('microFrameState="error"');
    }
  });

  it("aborts requests after the configured timeout", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      defaultTimeout: 5,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    });
    const handle = register(runtime);

    async function* reactOutput() {
      yield `${startMarker("frame")}${endMarker("frame")}`;
    }

    await collect(runtime.compose(reactOutput()));
    await expect(handle.started).rejects.toThrow("timed out after 5ms");
    await expect(handle.completed).rejects.toThrow("timed out after 5ms");
  });

  it("preserves malformed and duplicate markers without consuming twice", async () => {
    const fetch = vi.fn(async () => streamedResponse(["remote"]));
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      fetch,
    });
    register(runtime);

    async function* reactOutput() {
      yield "prefix<!--react-micro-frame:unknown:start-->";
      yield `${startMarker("frame")}${startMarker("frame")}`;
      yield "<!--react-micro-frame:unfinished";
    }

    const html = await collect(runtime.compose(reactOutput()));
    expect(html).toContain("<!--react-micro-frame:unknown:start-->");
    expect(html).toContain("<!--react-micro-frame:unfinished");
    expect(html.match(/remote/g)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a parallel payload that finishes in an unsafe parser context", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      composition: "parallel",
      defaultTimeout: 0,
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} })),
    });
    runtime.prepare({ id: "frame", src: "/remote" });

    async function* reactOutput() {
      yield `${startMarker("frame")}<plaintext>never safe`;
    }

    await expect(collect(runtime.compose(reactOutput()))).rejects.toThrow(
      "final HTML parser context",
    );
    runtime.abort();
  });

  it("handles React stream errors emitted synchronously from pipe", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
    });
    const abort = vi.fn();
    const rendered = {
      pipe(destination: NodeJS.WritableStream) {
        (destination as PassThrough).destroy(new Error("React stream failed"));
      },
      abort,
    };

    await expect(runtime.pipe(rendered, new PassThrough())).rejects.toThrow(
      "React stream failed",
    );
    expect(abort).toHaveBeenCalledWith(
      expect.objectContaining({ message: "React stream failed" }),
    );
  });

  it("tears down the pipeline when React pipe throws synchronously", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
    });
    const runtimeAbort = vi.spyOn(runtime, "abort");
    const abort = vi.fn();
    const rendered = {
      pipe() {
        throw new Error("React pipe failed");
      },
      abort,
    };
    const destination = new PassThrough();

    await expect(runtime.pipe(rendered, destination)).rejects.toThrow(
      "React pipe failed",
    );
    expect(destination.destroyed).toBe(true);
    expect(abort).toHaveBeenCalledWith(
      expect.objectContaining({ message: "React pipe failed" }),
    );
    expect(runtimeAbort).toHaveBeenCalledWith(
      expect.objectContaining({ message: "React pipe failed" }),
    );
  });

  it("aborts the React stream and runtime when piping fails", async () => {
    const runtime = createMicroFrameServerRuntime({
      origin: "https://host.test",
      defaultTimeout: 0,
      fetch: async () => new Promise<Response>(() => undefined),
    });
    const handle = register(runtime);
    const abort = vi.fn();
    const rendered = {
      pipe(destination: NodeJS.WritableStream) {
        destination.end("shell");
      },
      abort,
    };
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("destination failed"));
      },
    });

    await expect(runtime.pipe(rendered, destination)).rejects.toThrow(
      "destination failed",
    );
    expect(abort).toHaveBeenCalledWith(
      expect.objectContaining({ message: "destination failed" }),
    );
    await expect(handle.completed).rejects.toThrow("destination failed");
  });
});
