import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MicroFrame,
  MicroFrameErrorBoundary,
  MicroFrameProvider,
  useMicroFrameRuntime,
  type MicroFrameHandle,
  type MicroFrameRuntime,
} from "../src";

let dom: JSDOM;
let root: Root;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><div id=app></div>", {
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
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(document.getElementById("app")!);
});

afterEach(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

function Throw({ error }: { error: Error }): ReactNode {
  throw error;
}

describe("React components", () => {
  it("provides the runtime to descendants", async () => {
    const runtime: MicroFrameRuntime = {
      environment: "client",
      prepare: vi.fn(),
    };
    let observed: MicroFrameRuntime | undefined;

    function Consumer() {
      observed = useMicroFrameRuntime();
      return <span>consumer</span>;
    }

    await act(() =>
      root.render(
        <MicroFrameProvider runtime={runtime}>
          <Consumer />
        </MicroFrameProvider>,
      ),
    );

    expect(observed).toBe(runtime);
    expect(document.body.textContent).toContain("consumer");
  });

  it("reports missing providers through the error boundary", async () => {
    const onError = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    function Consumer() {
      useMicroFrameRuntime();
      return null;
    }

    await act(() =>
      root.render(
        <MicroFrameErrorBoundary
          fallback={(error) => <strong>{error.message}</strong>}
          onError={onError}
        >
          <Consumer />
        </MicroFrameErrorBoundary>,
      ),
    );

    expect(document.querySelector("strong")?.textContent).toContain(
      "inside MicroFrameProvider",
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Provider") }),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
    consoleError.mockRestore();
  });

  it.each([
    { fallback: <span>failed</span>, expected: "failed" },
    { fallback: undefined, expected: "" },
  ])(
    "renders a node or empty fallback after an error",
    async ({ fallback, expected }) => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      await act(() =>
        root.render(
          <MicroFrameErrorBoundary fallback={fallback}>
            <Throw error={new Error("boom")} />
          </MicroFrameErrorBoundary>,
        ),
      );

      expect(document.getElementById("app")?.textContent).toBe(expected);
    },
  );

  it("prepares, renders, and attaches a client micro-frame with all request options", async () => {
    const started = new Promise<void>(() => undefined);
    const completed = new Promise<void>(() => undefined);
    const requestFetch = vi.fn();
    const detach = vi.fn();
    const attach = vi.fn(() => detach);
    const prepare = vi.fn((request): MicroFrameHandle => ({
      id: request.id,
      generation: 3,
      request,
      started,
      completed,
    }));
    const runtime: MicroFrameRuntime = {
      environment: "client",
      prepare,
      attach,
    };

    await act(() =>
      root.render(
        <MicroFrameProvider runtime={runtime}>
          <MicroFrame
            src="/remote"
            headers={{ authorization: "token" }}
            cache="reload"
            timeout={0}
            fetch={requestFetch}
            loading={<b>loading</b>}
            className="shell"
            style={{ color: "red" }}
          />
        </MicroFrameProvider>,
      ),
    );

    const host = document.querySelector<HTMLElement>("[data-micro-frame-id]")!;
    const request = prepare.mock.calls[0]![0];
    expect(request).toMatchObject({
      src: "/remote",
      headers: { authorization: "token" },
      cache: "reload",
      timeout: 0,
      fetch: requestFetch,
    });
    expect(host.dataset.microFrameState).toBe("idle");
    expect(host.dataset.microFrameGeneration).toBe("3");
    expect(host.innerHTML).toContain("react-micro-frame:");
    expect(document.querySelector(".shell")?.getAttribute("style")).toContain(
      "color: red",
    );
    expect(document.querySelector("b")?.textContent).toBe("loading");
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({ request }),
      host,
    );

    await act(() => root.unmount());
    expect(detach).toHaveBeenCalledOnce();
    root = createRoot(document.getElementById("app")!);
  });

  it("omits absent request options and tolerates runtimes without client attachment", async () => {
    const prepare = vi.fn((request): MicroFrameHandle => ({
      id: request.id,
      generation: 0,
      request,
      started: new Promise<void>(() => undefined),
      completed: new Promise<void>(() => undefined),
    }));
    const runtime: MicroFrameRuntime = { environment: "server", prepare };

    await act(() =>
      root.render(
        <MicroFrameProvider runtime={runtime}>
          <MicroFrame src="/remote" />
        </MicroFrameProvider>,
      ),
    );

    expect(prepare.mock.calls[0]![0]).toEqual({
      id: expect.any(String),
      src: "/remote",
    });
    expect(
      document.querySelector<HTMLElement>("[data-micro-frame-id]")?.dataset
        .microFrameState,
    ).toBe("loading");
  });
});
