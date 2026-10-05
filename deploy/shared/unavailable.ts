/**
 * A module that stands in for one a deployment bundle must not contain: the
 * Worker's (deploy/cloudflare/azure-only.ts, aws-only.ts) and the Lambda
 * package's (deploy/aws/azure-only.ts). Every export is a function that
 * throws `message(name)` when called, constructed or read from, so a
 * configuration that selects such a module fails with a clear error instead
 * of a missing module.
 */

export function unavailableModule(message: (name: string) => string): Record<string, unknown> {
  const unavailable = (name: string): never => {
    throw new Error(message(name));
  };
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then" || typeof property === "symbol") return undefined; // so `await import()` resolves
        return new Proxy(function () {}, {
          apply: () => unavailable(String(property)),
          construct: () => unavailable(String(property)),
          get: () => unavailable(String(property)),
        });
      },
    },
  );
}
