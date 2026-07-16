import type { CSSProperties, ReactNode } from "react";

export type MicroFrameFetch = (
  input: string,
  init: RequestInit,
  defaultFetch: typeof globalThis.fetch,
) => Promise<Response>;

export interface MicroFrameRequest {
  id: string;
  src: string;
  headers?: Record<string, string>;
  cache?: RequestCache;
  timeout?: number;
  fetch?: MicroFrameFetch;
}

export interface MicroFrameHandle {
  readonly id: string;
  readonly generation: number;
  readonly request: MicroFrameRequest;
  /** Resolves when the first response body chunk is ready to render. */
  readonly started: Promise<void>;
  /** Resolves after the response and blocking browser resources complete. */
  readonly completed: Promise<void>;
}

export interface MicroFrameRuntime {
  readonly environment: "server" | "client";
  prepare(request: MicroFrameRequest): MicroFrameHandle;
  attach?(handle: MicroFrameHandle, host: HTMLElement): () => void;
}

export interface MicroFrameProps {
  src: string;
  headers?: Record<string, string>;
  cache?: RequestCache;
  /** Total request timeout in milliseconds. Set to 0 to disable it. */
  timeout?: number;
  fetch?: MicroFrameFetch;
  loading?: ReactNode;
  error?: ReactNode | ((error: Error) => ReactNode);
  className?: string;
  style?: CSSProperties;
}
