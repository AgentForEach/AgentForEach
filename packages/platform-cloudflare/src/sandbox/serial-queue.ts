/**
 * Runs async work one item at a time, in the order it was queued; a failed
 * item doesn't stop the ones after it. ContainerSandbox puts its lifecycle
 * changes through one, so they never interleave.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
