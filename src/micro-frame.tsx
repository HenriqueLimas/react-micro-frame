import {
  forwardRef,
  memo,
  Suspense,
  use,
  useEffect,
  useId,
  useRef,
} from "react";
import { useMicroFrameRuntime } from "./context";
import { endMarker, hostElementId, normalizeReactId, startMarker } from "./dom-markers";
import { MicroFrameErrorBoundary } from "./error-boundary";
import type { MicroFrameHandle, MicroFrameProps } from "./types";

function StreamStatus({ promise }: { promise: Promise<void> }) {
  use(promise);
  return null;
}

interface OpaqueHostProps {
  id: string;
  src: string;
  generation: number;
  initialState: "idle" | "loading";
}

const OpaqueHost = memo(
  forwardRef<HTMLDivElement, OpaqueHostProps>(function OpaqueHost(
    { id, src, generation, initialState },
    ref,
  ) {
    return (
      <div
        ref={ref}
        id={hostElementId(id)}
        data-micro-frame-id={id}
        data-micro-frame-src={src}
        data-micro-frame-generation={generation}
        data-micro-frame-state={initialState}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{
          __html: `${startMarker(id)}${endMarker(id)}`,
        }}
      />
    );
  }),
);

export function MicroFrame({
  src,
  headers,
  cache,
  timeout,
  fetch,
  loading = null,
  error = null,
  className,
  style,
}: MicroFrameProps) {
  const runtime = useMicroFrameRuntime();
  const id = normalizeReactId(useId());
  const hostRef = useRef<HTMLDivElement>(null);
  const initialHost = useRef<OpaqueHostProps | undefined>(undefined);

  const handle = runtime.prepare({
    id,
    src,
    ...(headers ? { headers } : {}),
    ...(cache ? { cache } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(fetch ? { fetch } : {}),
  });

  initialHost.current ??= {
    id,
    src,
    generation: handle.generation,
    initialState: runtime.environment === "server" ? "loading" : "idle",
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !runtime.attach) return;
    return runtime.attach(handle, host);
  }, [runtime, handle]);

  return (
    <div className={className} style={style} data-micro-frame-shell={id}>
      <MicroFrameErrorBoundary key={handle.generation} fallback={error}>
        <Suspense
          fallback={
            <div data-micro-frame-loading={id}>
              {loading}
            </div>
          }
        >
          <StreamStatus promise={handle.started} />
        </Suspense>
        <Suspense fallback={null}>
          <StreamStatus promise={handle.completed} />
        </Suspense>
      </MicroFrameErrorBoundary>

      <OpaqueHost ref={hostRef} {...initialHost.current} />
    </div>
  );
}
