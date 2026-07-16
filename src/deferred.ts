export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
  readonly settled: boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  // A resource may reject before React reads it during streaming SSR.
  // Keep the original promise rejected while preventing an unhandled rejection.
  void promise.catch(() => undefined);

  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    },
    reject(reason) {
      if (!settled) {
        settled = true;
        rejectPromise(reason);
      }
    },
  };
}
