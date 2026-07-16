import { createContext, useContext, type ReactNode } from "react";
import type { MicroFrameRuntime } from "./types";

const MicroFrameContext = createContext<MicroFrameRuntime | null>(null);

export function MicroFrameProvider({
  runtime,
  children,
}: {
  runtime: MicroFrameRuntime;
  children: ReactNode;
}) {
  return (
    <MicroFrameContext.Provider value={runtime}>
      {children}
    </MicroFrameContext.Provider>
  );
}

export function useMicroFrameRuntime(): MicroFrameRuntime {
  const runtime = useContext(MicroFrameContext);
  if (!runtime) {
    throw new Error("MicroFrame must be rendered inside MicroFrameProvider.");
  }
  return runtime;
}
