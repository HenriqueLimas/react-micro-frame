import { PassThrough, Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createDeferred, type Deferred } from "./deferred";
import { hostElementId, markerPrefix } from "./dom-markers";
import {
  MicroFrameError,
  MicroFrameHttpError,
  MicroFrameTimeoutError,
} from "./errors";
import type {
  MicroFrameFetch,
  MicroFrameHandle,
  MicroFrameRuntime,
} from "./types";

export interface MicroFrameServerRuntimeOptions {
  /** Origin used to resolve every micro-frame URL. */
  origin: string | URL;
  requestHeaders?: HeadersInit;
  /** How remote responses are composed into React's output. Defaults to `in-order`. */
  composition?: "in-order" | "parallel";
  /** Incoming headers forwarded to embedded applications. Defaults to none. */
  forwardHeaders?: string[];
  /** Allowed target origins. Defaults to the configured origin only. */
  allowedOrigins?: Array<string | URL>;
  fetch?: MicroFrameFetch;
  defaultTimeout?: number;
  /** Applied to runtime-generated completion scripts. */
  nonce?: string;
  /** Trusted Types policy created for parallel payload activation. Defaults to `react-micro-frame`. */
  trustedTypesPolicyName?: string;
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

interface BufferedPayload {
  entry: ServerEntry;
  state: "complete" | "error";
  chunks: Array<Uint8Array | string>;
  error?: Error;
}

export interface MicroFrameServerRuntime extends MicroFrameRuntime {
  readonly environment: "server";
  compose(
    source: AsyncIterable<Uint8Array | string>,
  ): AsyncGenerator<Uint8Array | string>;
  pipe(rendered: PipeableReactStream, destination: Writable): Promise<void>;
  abort(reason?: unknown): void;
}

export function createMicroFrameServerRuntime(
  options: MicroFrameServerRuntimeOptions,
): MicroFrameServerRuntime {
  const baseOrigin = new URL(options.origin).origin;
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? [baseOrigin]).map(
      (value) => new URL(value).origin,
    ),
  );
  const incomingHeaders = new Headers(options.requestHeaders);
  const trustedTypesPolicyName =
    options.trustedTypesPolicyName ?? "react-micro-frame";
  const entries = new Map<string, ServerEntry>();
  let aborted = false;

  const runtime: MicroFrameServerRuntime = {
    environment: "server",

    prepare(request) {
      const existing = entries.get(request.id);
      if (existing) {
        if (existing.request.src !== request.src) {
          throw new Error(
            `Conflicting micro-frame registration for ${request.id}.`,
          );
        }
        return existing;
      }

      if (aborted) {
        throw new Error(
          "Cannot register a micro-frame after the server runtime was aborted.",
        );
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
      if (options.composition === "parallel") {
        yield* composeParallel(source);
        return;
      }

      const decoder = new StringDecoder("utf8");
      let buffer = "";

      for await (const chunk of source) {
        buffer += decodeSourceChunk(decoder, chunk);
        yield* drain(false);
      }

      buffer += decoder.end();
      yield* drain(true);

      async function* drain(
        final: boolean,
      ): AsyncGenerator<Uint8Array | string> {
        while (buffer) {
          const markerAt = buffer.indexOf(markerPrefix);
          if (markerAt === -1) {
            if (final) {
              yield buffer;
              buffer = "";
            } else {
              const safeLength = Math.max(
                0,
                buffer.length - markerPrefix.length + 1,
              );
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

          const match =
            /^<!--react-micro-frame:([A-Za-z0-9_-]+):start-->$/.exec(marker);
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
        await pipeline(
          Readable.from(runtime.compose(reactOutput)),
          destination,
        );
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

  async function* composeParallel(
    source: AsyncIterable<Uint8Array | string>,
  ): AsyncGenerator<Uint8Array | string> {
    type SourceResult = IteratorResult<Uint8Array | string> & {
      type: "source";
    };
    type PayloadResult = BufferedPayload & {
      type: "payload";
      task: Promise<PayloadResult>;
    };

    type ComposeResult = SourceResult | PayloadResult;

    const decoder = new StringDecoder("utf8");
    const boundary = createHtmlBoundaryTracker();
    const iterator = source[Symbol.asyncIterator]();
    const pending = new Set<Promise<PayloadResult>>();
    let buffer = "";
    let sourceDone = false;
    let sourceNext = nextSource();

    while (!sourceDone || pending.size) {
      const candidates: Array<Promise<ComposeResult>> = sourceDone
        ? [...pending]
        : boundary.safe
          ? [sourceNext, ...pending]
          : [sourceNext];
      const result = await Promise.race(candidates);

      if (result.type === "payload") {
        pending.delete(result.task);
        if (result.state === "complete") {
          result.entry.start.resolve(undefined);
          result.entry.completion.resolve(undefined);
        } else {
          result.entry.start.reject(result.error);
          result.entry.completion.reject(result.error);
        }
        yield* result.chunks;
        continue;
      }

      if (result.done) {
        sourceDone = true;
        const decoded = decoder.end();
        boundary.write(decoded);
        buffer += decoded;
        yield* drain(true);
        if (!boundary.safe && pending.size) {
          throw new Error(
            "Cannot emit parallel micro-frame payloads in the final HTML parser context.",
          );
        }
      } else {
        const decoded = decodeSourceChunk(decoder, result.value);
        boundary.write(decoded);
        buffer += decoded;
        yield* drain(false);
        sourceNext = nextSource();
      }
    }

    function nextSource(): Promise<SourceResult> {
      return iterator.next().then((result) => ({ ...result, type: "source" }));
    }

    function* drain(final: boolean): Generator<string> {
      while (buffer) {
        const markerAt = buffer.indexOf(markerPrefix);
        if (markerAt === -1) {
          if (final) {
            yield buffer;
            buffer = "";
          } else {
            const safeLength = buffer.length - markerSuffixLength(buffer);
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

        const match = /^<!--react-micro-frame:([A-Za-z0-9_-]+):start-->$/.exec(
          marker,
        );
        if (match?.[1]) {
          const entry = entries.get(match[1]);
          if (entry && !entry.consumed) {
            let task!: Promise<PayloadResult>;
            task = bufferPayload(entry).then((payload) => ({
              ...payload,
              type: "payload",
              task,
            }));
            pending.add(task);
          }
        }
      }
    }
  }

  async function startRequest(entry: ServerEntry): Promise<Response> {
    const { request } = entry;
    const url = new URL(request.src, baseOrigin);
    if (!allowedOrigins.has(url.origin)) {
      throw new MicroFrameError(
        `Micro-frame origin is not allowed: ${url.origin}`,
        request.src,
      );
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
        entry.controller.abort(
          new MicroFrameTimeoutError(request.src, timeout),
        );
      }, timeout);
    }

    const init: RequestInit = {
      headers,
      signal: entry.controller.signal,
      redirect: "error",
      ...(request.cache ? { cache: request.cache } : {}),
    };
    const requestFetch = request.fetch ?? options.fetch;

    try {
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
      return response;
    } catch (error) {
      if (entry.controller.signal.aborted && entry.controller.signal.reason) {
        throw entry.controller.signal.reason;
      }
      throw error;
    }
  }

  async function bufferPayload(entry: ServerEntry): Promise<BufferedPayload> {
    entry.consumed = true;

    try {
      const response = await entry.response;
      const body = (response.body as unknown as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]();
      const chunks: Array<Uint8Array | string> = [];
      const first = await body.next();

      if (!first.done) chunks.push(first.value);

      while (true) {
        const chunk = await body.next();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }

      clearTimeout(entry.timer);
      return {
        entry,
        state: "complete",
        chunks: [
          startedScript(entry, true),
          `<template id="${payloadElementId(entry.id)}" style="display:none!important">`,
          ...chunks,
          "</template>",
          payloadActivationScript(entry),
          relocationScript(entry),
          settlementScript(entry, "complete", undefined, true),
        ],
      };
    } catch (cause) {
      clearTimeout(entry.timer);
      const error = toError(cause, entry.request.src);
      return {
        entry,
        state: "error",
        error,
        chunks: [settlementScript(entry, "error", error, true)],
      };
    }
  }

  async function* consume(
    entry: ServerEntry,
  ): AsyncGenerator<Uint8Array | string> {
    if (entry.consumed) return;
    entry.consumed = true;

    try {
      const response = await entry.response;
      const body = (response.body as unknown as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]();
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

  function startedScript(entry: ServerEntry, transient = false): string {
    const id = jsonForScript(hostElementId(entry.id));
    const loadingId = jsonForScript(entry.id);
    const nonce = options.nonce
      ? ` nonce="${escapeAttribute(options.nonce)}"`
      : "";

    if (transient) {
      const matches = hostMatchesExpression(entry);
      return `<script${nonce}>(()=>{const c=document.currentScript,h=document.getElementById(${id});if(!h||!(${matches})){c?.remove();return}h.dataset.microFrameState="streaming";const l=document.querySelector('[data-micro-frame-loading="'+${loadingId}+'"]');if(l)l.hidden=true;h.dispatchEvent(new CustomEvent("react-micro-frame:started"));c?.remove()})()</script>`;
    }

    return `<script${nonce}>(()=>{const h=document.getElementById(${id});if(!h)return;h.dataset.microFrameState="streaming";const l=document.querySelector('[data-micro-frame-loading="'+${loadingId}+'"]');if(l)l.hidden=true;h.dispatchEvent(new CustomEvent("react-micro-frame:started"))})()</script>`;
  }

  function payloadActivationScript(entry: ServerEntry): string {
    const hostId = jsonForScript(hostElementId(entry.id));
    const payloadId = jsonForScript(payloadElementId(entry.id));
    const matches = hostMatchesExpression(entry);
    const nonce = options.nonce
      ? ` nonce="${escapeAttribute(options.nonce)}"`
      : "";

    const open = jsonForScript(
      `<div id="${payloadElementId(entry.id)}" style="display:none!important">`,
    );
    const sentinel = jsonForScript(
      `<script${nonce}>document.getElementById(${payloadId}).__reactMicroFrameParsed=true;document.currentScript?.remove()</script></div>`,
    );

    const policyName = jsonForScript(trustedTypesPolicyName);

    // Keep buffered markup inert until its generation is accepted, then parse
    // it through the document stream to preserve native script semantics.
    return `<script${nonce}>(()=>{const c=document.currentScript,h=document.getElementById(${hostId}),t=document.getElementById(${payloadId});if(!t){c?.remove();return}if(!h||!(${matches})){t.remove();c?.remove();return}const x=t.innerHTML;t.remove();try{const v=${open}+x+${sentinel},g=globalThis,u=g.trustedTypes,m=g.__reactMicroFrameTrustedTypesPolicies??=new Map,k=${policyName},q=u&&(m.get(k)||(()=>{const p=u.createPolicy(k,{createHTML:x=>x});m.set(k,p);return p})());document.write(q?q.createHTML(v):v)}catch(e){const m=e instanceof Error?e.message:String(e);h.dataset.microFrameActivationError=m;h.dataset.microFrameState="error";h.dataset.microFrameError=m;h.dispatchEvent(new CustomEvent("react-micro-frame:settled",{detail:{state:"error",error:m}}));c?.remove();return}const p=document.getElementById(${payloadId});if(p&&!p.__reactMicroFrameParsed){for(const o of [...p.querySelectorAll("script")]){const n=document.createElement("script");for(const x of o.attributes)n.setAttribute(x.name,x.value);n.text=o.text;o.replaceWith(n)}}c?.remove()})()</script>`;
  }

  function relocationScript(entry: ServerEntry): string {
    const hostId = jsonForScript(hostElementId(entry.id));
    const payloadId = jsonForScript(payloadElementId(entry.id));
    const endData = jsonForScript(`react-micro-frame:${entry.id}:end`);
    const matches = hostMatchesExpression(entry);
    const nonce = options.nonce
      ? ` nonce="${escapeAttribute(options.nonce)}"`
      : "";

    return `<script${nonce}>(()=>{const c=document.currentScript,h=document.getElementById(${hostId}),p=document.getElementById(${payloadId});if(!p){c?.remove();return}if(!h||!(${matches})){p.remove();c?.remove();return}let e;for(const n of h.childNodes)if(n.nodeType===8&&n.data===${endData}){e=n;break}const b=p.parentNode===h?p:e;if(!b){p.remove();c?.remove();return}const f=document.createDocumentFragment();while(p.firstChild)f.appendChild(p.firstChild);h.insertBefore(f,b);p.remove();c?.remove()})()</script>`;
  }

  function settlementScript(
    entry: ServerEntry,
    state: "complete" | "error",
    error?: Error,
    transient = false,
  ): string {
    const id = jsonForScript(hostElementId(entry.id));
    const eventState = jsonForScript(state);
    const message = jsonForScript(error?.message ?? "");
    const loadingId = jsonForScript(entry.id);
    const clear =
      state === "error"
        ? transient
          ? transientErrorClearScript(entry, loadingId)
          : `let s;for(const n of h.childNodes){if(n.nodeType===8&&n.data.endsWith(":start")){s=n;break}}if(s)while(s.nextSibling)s.nextSibling.remove();const l=document.querySelector('[data-micro-frame-loading="'+${loadingId}+'"]');if(l)l.hidden=true;`
        : "";
    const nonce = options.nonce
      ? ` nonce="${escapeAttribute(options.nonce)}"`
      : "";

    if (transient) {
      const matches = hostMatchesExpression(entry);
      const activationGuard =
        state === "complete"
          ? `if(h.dataset.microFrameActivationError){c?.remove();return}`
          : "";
      return `<script${nonce}>(()=>{const c=document.currentScript,h=document.getElementById(${id});if(!h||!(${matches})){c?.remove();return}${activationGuard}${clear}h.dataset.microFrameState=${eventState};h.dataset.microFrameError=${message};h.dispatchEvent(new CustomEvent("react-micro-frame:settled",{detail:{state:${eventState},error:${message}}}));c?.remove()})()</script>`;
    }

    return `<script${nonce}>(()=>{const h=document.getElementById(${id});if(!h)return;${clear}h.dataset.microFrameState=${eventState};h.dataset.microFrameError=${message};h.dispatchEvent(new CustomEvent("react-micro-frame:settled",{detail:{state:${eventState},error:${message}}}))})()</script>`;
  }

  function hostMatchesExpression(entry: ServerEntry): string {
    const src = jsonForScript(entry.request.src);
    const generation = jsonForScript(String(entry.generation));
    return `h.dataset.microFrameSrc===${src}&&h.dataset.microFrameGeneration===${generation}`;
  }

  function transientErrorClearScript(
    entry: ServerEntry,
    loadingId: string,
  ): string {
    const startData = jsonForScript(`react-micro-frame:${entry.id}:start`);
    const endData = jsonForScript(`react-micro-frame:${entry.id}:end`);
    return `let s,e;for(const n of h.childNodes){if(n.nodeType!==8)continue;if(n.data===${startData})s=n;else if(n.data===${endData})e=n}if(s){let n=s.nextSibling;while(n&&n!==e){const next=n.nextSibling;n.remove();n=next}}const l=document.querySelector('[data-micro-frame-loading="'+${loadingId}+'"]');if(l)l.hidden=true;`;
  }
}

function decodeSourceChunk(
  decoder: StringDecoder,
  chunk: Uint8Array | string,
): string {
  return typeof chunk === "string"
    ? decoder.end() + chunk
    : decoder.write(Buffer.from(chunk));
}

function markerSuffixLength(value: string): number {
  const max = Math.min(value.length, markerPrefix.length - 1);
  for (let length = max; length > 0; length--) {
    if (markerPrefix.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function createHtmlBoundaryTracker(): {
  readonly safe: boolean;
  write(html: string): void;
} {
  const rawElements = new Set([
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
  ]);
  const voidElements = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  // Payload start tags such as form, a, button, list items, or table cells
  // can otherwise close or be ignored by parser state outside the temporary div.
  const unsafeContainers = new Set([
    "a",
    "button",
    "dd",
    "dt",
    "form",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "li",
    "math",
    "nobr",
    "optgroup",
    "option",
    "p",
    "select",
    "svg",
    "table",
    "template",
  ]);
  const elements: string[] = [];
  let state: "data" | "tag" | "comment" | "raw" | "plaintext" = "data";
  let quote = "";
  let tag = "";
  let rawTag = "";
  let rawCloseState:
    "text" | "open" | "slash" | "name" | "after-name" | "after-slash" = "text";
  let rawNameAt = 0;
  let scriptEscapeState: "data" | "escaped" | "double-escaped" = "data";
  let scriptRecent = "";
  let entity = false;

  return {
    get safe() {
      return (
        state === "data" &&
        !entity &&
        !elements.some((element) => unsafeContainers.has(element))
      );
    },
    write(html) {
      for (const char of html) {
        if (state === "plaintext") continue;

        if (state === "comment") {
          tag = (tag + char).slice(-4);
          if (tag.endsWith("-->") || tag.endsWith("--!>")) {
            state = "data";
            tag = "";
          }
          continue;
        }

        if (state === "raw") {
          if (rawTag === "script") {
            scanScriptCharacter(char);
          } else {
            scanRawCharacter(char);
          }
          continue;
        }

        if (state === "tag") {
          tag += char;
          if (tag === "<!--") {
            state = "comment";
            tag = "";
          } else if (quote) {
            if (char === quote) quote = "";
          } else if (char === '"' || char === "'") {
            quote = char;
          } else if (char === ">") {
            processTag(tag);
            tag = "";
          }
          continue;
        }

        if (entity) {
          if (char === ";") {
            entity = false;
            continue;
          }
          if (/[A-Za-z0-9#]/.test(char)) continue;
          entity = false;
        }
        if (char === "<") {
          state = "tag";
          tag = "<";
        } else if (char === "&") {
          entity = true;
        }
      }
    },
  };

  function processTag(value: string): void {
    const match = /^<\s*(\/?)\s*([A-Za-z0-9]+)/.exec(value);
    const name = match?.[2]?.toLowerCase();
    if (!name) {
      state = "data";
      return;
    }

    if (match?.[1]) {
      closeElement(name);
      state = "data";
      return;
    }

    if (!voidElements.has(name)) elements.push(name);
    if (name === "plaintext") {
      state = "plaintext";
    } else if (rawElements.has(name)) {
      state = "raw";
      rawTag = name;
      rawCloseState = "text";
      rawNameAt = 0;
      scriptEscapeState = "data";
      scriptRecent = "";
    } else {
      state = "data";
    }
  }

  function scanScriptCharacter(char: string): void {
    const lower = char.toLowerCase();
    scriptRecent = (scriptRecent + lower).slice(-16);

    if (scriptEscapeState === "double-escaped") {
      if (hasScriptTagBoundary("</script", lower)) {
        scriptEscapeState = "escaped";
        rawCloseState = "text";
        rawNameAt = 0;
      }
      return;
    }

    if (scriptEscapeState === "escaped") {
      if (hasScriptTagBoundary("<script", lower)) {
        scriptEscapeState = "double-escaped";
        rawCloseState = "text";
        rawNameAt = 0;
        return;
      }
      if (scriptRecent.endsWith("-->")) scriptEscapeState = "data";
    } else if (scriptRecent.endsWith("<!--")) {
      scriptEscapeState = "escaped";
    }

    scanRawCharacter(char);
  }

  function hasScriptTagBoundary(value: string, char: string): boolean {
    return (
      (char === "/" || char === ">" || isHtmlWhitespace(char)) &&
      scriptRecent.endsWith(value + char)
    );
  }

  function scanRawCharacter(char: string): void {
    if (rawCloseState === "text") {
      if (char === "<") rawCloseState = "open";
      return;
    }
    if (rawCloseState === "open") {
      rawCloseState = char === "/" ? "slash" : char === "<" ? "open" : "text";
      return;
    }
    if (rawCloseState === "slash") {
      if (char.toLowerCase() === rawTag[0]) {
        rawNameAt = 1;
        rawCloseState = rawNameAt === rawTag.length ? "after-name" : "name";
      } else {
        restartRawClose(char);
      }
      return;
    }
    if (rawCloseState === "name") {
      if (char.toLowerCase() === rawTag[rawNameAt]) {
        rawNameAt++;
        if (rawNameAt === rawTag.length) rawCloseState = "after-name";
      } else {
        restartRawClose(char);
      }
      return;
    }
    if (rawCloseState === "after-name") {
      if (char === ">") {
        finishRawElement();
      } else if (char === "/") {
        rawCloseState = "after-slash";
      } else if (!isHtmlWhitespace(char)) {
        restartRawClose(char);
      }
      return;
    }
    if (char === ">") {
      finishRawElement();
    } else if (!isHtmlWhitespace(char)) {
      restartRawClose(char);
    }
  }

  function restartRawClose(char: string): void {
    rawCloseState = char === "<" ? "open" : "text";
    rawNameAt = 0;
  }

  function finishRawElement(): void {
    closeElement(rawTag);
    state = "data";
    rawTag = "";
    rawCloseState = "text";
    rawNameAt = 0;
    scriptEscapeState = "data";
    scriptRecent = "";
  }

  function isHtmlWhitespace(char: string): boolean {
    return (
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\f" ||
      char === "\r"
    );
  }

  function closeElement(name: string): void {
    const at = elements.lastIndexOf(name);
    if (at !== -1) elements.length = at;
  }
}

function payloadElementId(id: string): string {
  return `react-micro-frame-payload-${id}`;
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
