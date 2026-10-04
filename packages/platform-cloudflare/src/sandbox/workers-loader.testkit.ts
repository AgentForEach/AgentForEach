/**
 * A Node module hook that resolves "cloudflare:workers" to a stub, so a test
 * can load a Durable Object module:
 *
 *   register("./workers-loader.testkit.js", import.meta.url);
 *   const { ContainerSandbox } = await import("./container-sandbox.js");
 */

type Resolved = { url: string; shortCircuit?: boolean };

export async function resolve(
  specifier: string,
  context: unknown,
  next: (specifier: string, context: unknown) => Promise<Resolved>,
): Promise<Resolved> {
  if (specifier === "cloudflare:workers") {
    return { url: new URL("./workers-stub.testkit.js", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
