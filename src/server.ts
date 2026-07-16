import { PassThrough, Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createDeferred, type Deferred } from "./deferred";
import { hostElementId, markerPrefix } from "./dom-markers";
import { MicroFrameError, MicroFrameHttpError, MicroFrameTimeoutError } from "./errors";
import type {
  MicroFrameFetch,
  MicroFrameHandle,
  MicroFrameRuntime,
} from "./types";

export interface MicroFrameServerRuntimeOptions {
  /** Origin used to resolve every micro-frame URL. */
  origin: string | URL;
  requestHeaders?: HeadersInit;
  /** Incoming headers forwarded to embedded applications. Defaults to none. */
  forwardHeaders?: string[];
  /** Allowed target origins. Defaults to the configured origin only. */
  allowedOrigins?: Array<string | URL>;
  fetch?: MicroFrameFetch;
  defaultTimeout?: number;
  /** Applied to runtime-generated completion scripts. */
  nonce?: string;
}

export interface PipeableReactStream {
  pipe(destination: NodeJS.WritableStream): void;
  abort?(reason?: unknown): void;
}

interface ServerEntry extends MicroFrameHandle {
  start: Deferred<void>;
  completion: Deferred<void>;
  controller: AbortController;
  response: Promise<Response>;
  consumed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface MicroFrameServerRuntime extends MicroFrameRuntime {
  readonly environment: "server";
  compose(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<Uint8Array | string>;
  pipe(rendered: PipeableReactStream, destination: Writable): Promise<void>;
  abort(reason?: unknown): void;
}

export function createMicroFrameServerRuntime(
  options: MicroFrameServerRuntimeOptions,
): MicroFrameServerRuntime {
  const baseOrigin = new URL(options.origin).origin;
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? [baseOrigin]).map((value) => new URL(value).origin),
  );
  const incomingHeaders = new Headers(options.requestHeaders);
  const entries = new Map<string, ServerEntry>();
  let aborted = false;

  const runtime: MicroFrameServerRuntime = {
    environment: "server",

    prepare(request) {
      const existing = entries.get(request.id);
      if (existing) {
        if (existing.request.src !== request.src) {
          throw new Error(`Conflicting micro-frame registration for ${request.id}.`);
        }
        return existing;
      }

      if (aborted) {
        throw new Error("Cannot register a micro-frame after the server runtime was aborted.");
      }

      const start = createDeferred<void>();
      const completion = createDeferred<void>();
      const controller = new AbortController();
      const entry = {
        id: request.id,
        generation: 0,
        request,
        started: start.promise,
        completed: completion.promise,
        start,
        completion,
        controller,
        consumed: false,
        response: Promise.resolve(undefined as unknown as Response),
      } satisfies ServerEntry;

      entry.response = startRequest(entry);
      // The composer consumes this rejection later; avoid an early unhandled rejection.
      void entry.response.catch(() => undefined);
      entries.set(request.id, entry);
      return entry;
    },

    async *compose(source) {
      const decoder = new StringDecoder("utf8");
      let buffer = "";

      for await (const chunk of source) {
        buffer += typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
        yield* drain(false);
      }

      buffer += decoder.end();
      yield* drain(true);

      async function* drain(final: boolean): AsyncGenerator<Uint8Array | string> {
        while (buffer) {
          const markerAt = buffer.indexOf(markerPrefix);
          if (markerAt === -1) {
            if (final) {
              yield buffer;
              buffer = "";
            } else {
              const safeLength = Math.max(0, buffer.length - markerPrefix.length + 1);
              if (safeLength) {
                yield buffer.slice(0, safeLength);
                buffer = buffer.slice(safeLength);
              }
            }
            return;
          }

          if (markerAt > 0) {
            yield buffer.slice(0, markerAt);
            buffer = buffer.slice(markerAt);
            continue;
          }

          const markerEnd = buffer.indexOf("-->");
          if (markerEnd === -1) {
            if (final) {
              yield buffer;
              buffer = "";
            }
            return;
          }

          const marker = buffer.slice(0, markerEnd + 3);
          buffer = buffer.slice(markerEnd + 3);
          yield marker;

          const match = /^<!--react-micro-frame:([A-Za-z0-9_-]+):start-->$/.exec(marker);
          if (match?.[1]) {
            const entry = entries.get(match[1]);
            if (entry) yield* consume(entry);
          }
        }
      }
    },

    async pipe(rendered, destination) {
      const reactOutput = new PassThrough();
      rendered.pipe(reactOutput);

      try {
        await pipeline(Readable.from(runtime.compose(reactOutput)), destination);
      } catch (error) {
        rendered.abort?.(error);
        runtime.abort(error);
        throw error;
      }
    },

    abort(reason = new Error("Micro-frame server runtime aborted.")) {
      if (aborted) return;
      aborted = true;
      for (const entry of entries.values()) {
        clearTimeout(entry.timer);
        entry.controller.abort(reason);
        entry.start.reject(reason);
        entry.completion.reject(reason);
      }
    },
  };

  return runtime;

  async function startRequest(entry: ServerEntry): Promise<Response> {
    const { request } = entry;
    const url = new URL(request.src, baseOrigin);
    if (!allowedOrigins.has(url.origin)) {
      throw new MicroFrameError(`Micro-frame origin is not allowed: ${url.origin}`, request.src);
    }

    const headers = new Headers();
    for (const name of options.forwardHeaders ?? []) {
      const value = incomingHeaders.get(name);
      if (value !== null) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      headers.set(name, value);
    }
    headers.set("accept", "text/html");

    const timeout = request.timeout ?? options.defaultTimeout ?? 30_000;
    if (timeout > 0) {
      entry.timer = setTimeout(() => {
        entry.controller.abort(new MicroFrameTimeoutError(request.src, timeout));
      }, timeout);
    }

    const init: RequestInit = {
      headers,
      signal: entry.controller.signal,
      ...(request.cache ? { cache: request.cache } : {}),
    };
    const requestFetch = request.fetch ?? options.fetch;

    try {
      const response = await (requestFetch
        ? requestFetch(url.href, init, globalThis.fetch)
        : globalThis.fetch(url, init));

      if (!response.ok) {
        throw new MicroFrameHttpError(
          url.href,
          response.status,
          response.statusText,
        );
      }
      if (!response.body) {
        throw new MicroFrameError("Micro-frame response body is not a stream.", url.href);
      }
      return response;
    } catch (error) {
      if (entry.controller.signal.aborted && entry.controller.signal.reason) {
        throw entry.controller.signal.reason;
      }
      throw error;
    }
  }

  async function* consume(entry: ServerEntry): AsyncGenerator<Uint8Array | string> {
    if (entry.consumed) return;
    entry.consumed = true;

    try {
      const response = await entry.response;
      const body = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      const first = await body.next();

      entry.start.resolve(undefined);
      yield startedScript(entry);
      if (!first.done) yield first.value;

      while (true) {
        const chunk = await body.next();
        if (chunk.done) break;
        yield chunk.value;
      }

      clearTimeout(entry.timer);
      entry.completion.resolve(undefined);
      yield settlementScript(entry, "complete");
    } catch (cause) {
      clearTimeout(entry.timer);
      const error = toError(cause, entry.request.src);
      entry.start.reject(error);
      entry.completion.reject(error);
      yield settlementScript(entry, "error", error);
    }
  }

  function startedScript(entry: ServerEntry): string {
    const id = jsonForScript(hostElementId(entry.id));
    const loadingId = jsonForScript(entry.id);
    const nonce = options.nonce ? ` nonce="${escapeAttribute(options.nonce)}"` : "";

    return `<script${nonce}>(()=>{const h=document.getElementById(${id});if(!h)return;h.dataset.microFrameState="streaming";const l=document.querySelector('[data-micro-frame-loading="'+${loadingId}+'"]');if(l)l.hidden=true;h.dispatchEvent(new CustomEvent("react-micro-frame:started"))})()</script>`;
  }

  function settlementScript(
    entry: ServerEntry,
    state: "complete" | "error",
    error?: Error,
  ): string {
    const id = jsonForScript(hostElementId(entry.id));
    const eventState = jsonForScript(state);
    const message = jsonForScript(error?.message ?? "");
    const loadingId = jsonForScript(entry.id);
    const clear = state === "error"
      ? `let s;for(const n of h.childNodes){if(n.nodeType===8&&n.data.endsWith(":start")){s=n;break}}if(s)while(s.nextSibling)s.nextSibling.remove();const l=document.querySelector('[data-micro-frame-loading="'+${loadingId}+'"]');if(l)l.hidden=true;`
      : "";
    const nonce = options.nonce ? ` nonce="${escapeAttribute(options.nonce)}"` : "";

    return `<script${nonce}>(()=>{const h=document.getElementById(${id});if(!h)return;${clear}h.dataset.microFrameState=${eventState};h.dataset.microFrameError=${message};h.dispatchEvent(new CustomEvent("react-micro-frame:settled",{detail:{state:${eventState},error:${message}}}))})()</script>`;
  }
}

function toError(cause: unknown, src: string): Error {
  return cause instanceof Error
    ? cause
    : new MicroFrameError(String(cause), src, { cause });
}

function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export type {
  MicroFrameFetch,
  MicroFrameHandle,
  MicroFrameRequest,
  MicroFrameRuntime,
} from "./types";
