export class MicroFrameError extends Error {
  override readonly name: string = "MicroFrameError";

  constructor(
    message: string,
    readonly src: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class MicroFrameHttpError extends MicroFrameError {
  override readonly name = "MicroFrameHttpError";

  constructor(
    src: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(
      `Micro-frame request failed with ${status}${statusText ? ` ${statusText}` : ""}: ${src}`,
      src,
    );
  }
}

export class MicroFrameTimeoutError extends MicroFrameError {
  override readonly name = "MicroFrameTimeoutError";

  constructor(src: string, readonly timeout: number) {
    super(`Micro-frame request timed out after ${timeout}ms: ${src}`, src);
  }
}
