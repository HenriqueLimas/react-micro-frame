import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  fallback?: ReactNode | ((error: Error) => ReactNode);
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error?: Error;
}

export class MicroFrameErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback } = this.props;
    return typeof fallback === "function" ? fallback(error) : fallback ?? null;
  }
}
