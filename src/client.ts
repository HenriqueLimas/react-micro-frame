import writableDOM from "writable-dom";
import { decodeReadableStream } from "./decode";
import { createDeferred, type Deferred } from "./deferred";
import { clearBetween, findMarkers } from "./dom-markers";
import {
  MicroFrameError,
  MicroFrameHttpError,
  MicroFrameTimeoutError,
} from "./errors";
import type {
  MicroFrameFetch,
  MicroFrameHandle,
  MicroFrameRequest,
  MicroFrameRuntime,
} from "./types";

export interface MicroFrameClientRuntimeOptions {
  fetch?: MicroFrameFetch;
  defaultTimeout?: number;
  allowedOrigins?: Array<string | URL>;
}

interface WritableDOMWriter {
  write(html: string): void;
  close(): Promise<void>;
  abort(error: Error): void;
}

interface ClientEntry extends MicroFrameHandle {
  start: Deferred<void>;
  completion: Deferred<void>;
  controller?: AbortController;
  writer?: WritableDOMWriter;
  host?: HTMLElement;
  detachSettlementListener: (() => void) | undefined;
  attachments: number;
  stopped: boolean;
}

export interface MicroFrameClientRuntime extends MicroFrameRuntime {
  readonly environment: "client";
  attach(handle: MicroFrameHandle, host: HTMLElement): () => void;
  abort(): void;
}

export function createMicroFrameClientRuntime(
  options: MicroFrameClientRuntimeOptions = {},
): MicroFrameClientRuntime {
  const prepared = new Map<string, ClientEntry>();
  const active = new Map<string, ClientEntry>();
  const generations = new Map<string, number>();

  const runtime: MicroFrameClientRuntime = {
    environment: "client",

    prepare(request) {
      const existing = prepared.get(request.id);
      if (
        existing &&
        !existing.stopped &&
        requestsMatch(existing.request, request)
      )
        return existing;

      const generation = (generations.get(request.id) ?? -1) + 1;
      generations.set(request.id, generation);
      const start = createDeferred<void>();
      const completion = createDeferred<void>();
      const entry = {
        id: request.id,
        generation,
        request,
        started: start.promise,
        completed: completion.promise,
        start,
        completion,
        attachments: 0,
        stopped: false,
        detachSettlementListener: undefined,
      } satisfies ClientEntry;
      prepared.set(request.id, entry);
      return entry;
    },

    attach(publicHandle, host) {
      const entry = publicHandle as ClientEntry;
      entry.attachments++;

      const previous = active.get(entry.id);
      if (previous !== entry) {
        if (previous) stop(previous, "superseded");
        active.set(entry.id, entry);
        entry.host = host;
        adoptOrStart(entry);
      }

      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        entry.attachments--;

        // React Strict Mode immediately reattaches effects. Deferring cleanup
        // avoids issuing a duplicate request during that development-only cycle.
        queueMicrotask(() => {
          if (entry.attachments === 0 && active.get(entry.id) === entry) {
            active.delete(entry.id);
            stop(entry, "detached");
          }
        });
      };
    },

    abort() {
      for (const entry of active.values()) stop(entry, "runtime-aborted");
      active.clear();
    },
  };

  return runtime;

  function adoptOrStart(entry: ClientEntry): void {
    const host = entry.host!;
    const state = host.dataset.microFrameState;
    const renderedSrc = host.dataset.microFrameSrc;

    if (renderedSrc === entry.request.src && state !== "idle") {
      if (state === "complete") {
        hideLoadingFallback(host, entry.id);
        entry.start.resolve(undefined);
        entry.completion.resolve(undefined);
        return;
      }
      if (state === "error") {
        const error = new MicroFrameError(
          host.dataset.microFrameError || "Server micro-frame failed.",
          entry.request.src,
        );
        entry.start.reject(error);
        entry.completion.reject(error);
        return;
      }
      if (state === "streaming") {
        hideLoadingFallback(host, entry.id);
        entry.start.resolve(undefined);
      }

      const onStarted = () => {
        hideLoadingFallback(host, entry.id);
        entry.start.resolve(undefined);
      };
      const onSettled = () => {
        entry.detachSettlementListener?.();
        entry.detachSettlementListener = undefined;
        if (host.dataset.microFrameState === "complete") {
          hideLoadingFallback(host, entry.id);
          entry.start.resolve(undefined);
          entry.completion.resolve(undefined);
        } else {
          const error = new MicroFrameError(
            host.dataset.microFrameError || "Server micro-frame failed.",
            entry.request.src,
          );
          entry.start.reject(error);
          entry.completion.reject(error);
        }
      };
      host.addEventListener("react-micro-frame:started", onStarted);
      host.addEventListener("react-micro-frame:settled", onSettled);
      entry.detachSettlementListener = () => {
        host.removeEventListener("react-micro-frame:started", onStarted);
        host.removeEventListener("react-micro-frame:settled", onSettled);
      };
      return;
    }

    void startClientRequest(entry);
  }

  async function startClientRequest(entry: ClientEntry): Promise<void> {
    const host = entry.host!;
    const controller = new AbortController();
    entry.controller = controller;
    const timeout = entry.request.timeout ?? options.defaultTimeout ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let markers: ReturnType<typeof findMarkers> | undefined;

    try {
      markers = findMarkers(host);
      clearBetween(markers.start, markers.end);
      host.dataset.microFrameSrc = entry.request.src;
      host.dataset.microFrameGeneration = String(entry.generation);
      host.dataset.microFrameState = "loading";
      delete host.dataset.microFrameError;
      delete host.dataset.microFrameActivationError;

      if (timeout > 0) {
        timer = setTimeout(() => {
          controller.abort(
            new MicroFrameTimeoutError(entry.request.src, timeout),
          );
        }, timeout);
      }
      const url = new URL(entry.request.src, window.location.origin);
      const allowedOrigins = new Set(
        (options.allowedOrigins ?? [window.location.origin]).map(
          (value) => new URL(value, window.location.origin).origin,
        ),
      );
      if (!allowedOrigins.has(url.origin)) {
        throw new MicroFrameError(
          `Micro-frame origin is not allowed: ${url.origin}`,
          entry.request.src,
        );
      }

      const headers = new Headers(entry.request.headers);
      headers.set("accept", "text/html");
      const init: RequestInit = {
        headers,
        signal: controller.signal,
        redirect: "error",
        ...(entry.request.cache ? { cache: entry.request.cache } : {}),
      };
      const requestFetch = entry.request.fetch ?? options.fetch;
      const response = await (requestFetch
        ? requestFetch(url.href, init, globalThis.fetch)
        : globalThis.fetch(url, init));

      if (response.url) {
        const responseOrigin = new URL(response.url).origin;
        if (!allowedOrigins.has(responseOrigin)) {
          throw new MicroFrameError(
            `Micro-frame response origin is not allowed: ${responseOrigin}`,
            response.url,
          );
        }
      }
      if (!response.ok) {
        throw new MicroFrameHttpError(
          url.href,
          response.status,
          response.statusText,
        );
      }
      if (!response.body) {
        throw new MicroFrameError(
          "Micro-frame response body is not a stream.",
          url.href,
        );
      }

      const writer = writableDOM(host, markers.start) as WritableDOMWriter;
      entry.writer = writer;
      let hasStarted = false;
      for await (const html of decodeReadableStream(response.body)) {
        writer.write(html);
        if (!hasStarted) {
          hasStarted = true;
          host.dataset.microFrameState = "streaming";
          hideLoadingFallback(host, entry.id);
          host.dispatchEvent(new CustomEvent("react-micro-frame:started"));
          entry.start.resolve(undefined);
        }
      }
      if (!hasStarted) {
        host.dataset.microFrameState = "streaming";
        hideLoadingFallback(host, entry.id);
        host.dispatchEvent(new CustomEvent("react-micro-frame:started"));
        entry.start.resolve(undefined);
      }
      await writer.close();

      if (active.get(entry.id) !== entry || entry.stopped) return;
      host.dataset.microFrameState = "complete";
      host.dispatchEvent(
        new CustomEvent("react-micro-frame:settled", {
          detail: { state: "complete", error: "" },
        }),
      );
      entry.completion.resolve(undefined);
    } catch (cause) {
      if (entry.stopped) return;
      const error =
        controller.signal.aborted && controller.signal.reason
          ? toError(controller.signal.reason, entry.request.src)
          : toError(cause, entry.request.src);
      entry.writer?.abort(error);
      entry.start.reject(error);
      if (markers) clearBetween(markers.start, markers.end);
      host.dataset.microFrameState = "error";
      host.dataset.microFrameError = error.message;
      host.dispatchEvent(
        new CustomEvent("react-micro-frame:settled", {
          detail: { state: "error", error: error.message },
        }),
      );
      entry.completion.reject(error);
    } finally {
      clearTimeout(timer);
    }
  }

  function stop(entry: ClientEntry, reason: string): void {
    if (entry.stopped) return;
    entry.stopped = true;
    entry.detachSettlementListener?.();
    const error = new DOMException(`Micro-frame ${reason}.`, "AbortError");
    entry.controller?.abort(error);
    entry.writer?.abort(error);
    // Superseded and unmounted resources should settle without showing an error.
    entry.start.resolve(undefined);
    entry.completion.resolve(undefined);
  }
}

function hideLoadingFallback(host: HTMLElement, id: string): void {
  // React may defer the Suspense retry, so coordinate visibility immediately
  // rather than allowing the streamed host and its fallback to paint together.
  const shell = host.parentElement;
  if (!shell) return;

  for (const child of shell.children) {
    if (child.getAttribute("data-micro-frame-loading") === id) {
      (child as HTMLElement).style.display = "none";
      return;
    }
  }
}

function requestsMatch(a: MicroFrameRequest, b: MicroFrameRequest): boolean {
  return (
    a.src === b.src &&
    a.cache === b.cache &&
    a.timeout === b.timeout &&
    a.fetch === b.fetch &&
    JSON.stringify(a.headers ?? {}) === JSON.stringify(b.headers ?? {})
  );
}

function toError(cause: unknown, src: string): Error {
  return cause instanceof Error
    ? cause
    : new MicroFrameError(String(cause), src, { cause });
}

export type {
  MicroFrameFetch,
  MicroFrameHandle,
  MicroFrameRequest,
  MicroFrameRuntime,
} from "./types";
