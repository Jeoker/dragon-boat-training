/** Real RPC payloads own a disposer; modeled ports may return plain objects.
 * Scope always exposes a disposable resource without requiring models to fake
 * capabilities. Do not forward the payload's disposer to another Worker. */
export function rpcResultScope<T>(value: T) {
  return { value, [Symbol.dispose]() {
    if (value !== null && typeof value === "object") {
      const dispose = (value as { [Symbol.dispose]?: () => void })[Symbol.dispose];
      if (typeof dispose === "function") dispose.call(value);
    }
  } };
}
