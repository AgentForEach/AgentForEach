/**
 * What the ContainerSandbox object and the backend calling it agree on,
 * without the Workers runtime (so the backend is testable in Node).
 */

/**
 * Response header set from a start of the sandbox until the backend confirms
 * it is in its owner's index (ContainerSandbox.indexed()), so an indexing
 * that failed is retried on the next call.
 */
export const UNINDEXED_HEADER = "x-sandbox-unindexed";
