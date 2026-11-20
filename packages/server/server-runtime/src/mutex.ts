/**
 * A per-key mutex — the in-process per-room serialization. Ops for the same room run one at a time,
 * in arrival order; different rooms run concurrently. Ready for an async Store later (the engine
 * itself is synchronous, so today this just orders requests).
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn); // run fn after prev settles (value/error ignored)
    // The tail resolves once `result` settles, so the next caller queues behind it.
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
