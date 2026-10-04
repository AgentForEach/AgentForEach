/**
 * Stands in for "cloudflare:workers" in Node tests (see
 * workers-loader.testkit.ts): just enough for a Durable Object class to be
 * constructed with a fake state.
 */

export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  constructor(
    protected readonly ctx: ExecutionContext & { props: Props },
    protected readonly env: Env,
  ) {}
}
