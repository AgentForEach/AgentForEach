/**
 * AgentForEach Skills Layer — Sandbox provider registry
 *
 * Maps `skills.sandbox.provider` (or SANDBOX_PROVIDER) to a backend factory.
 * The ACA providers are registered by ./factory.ts; a platform pack registers
 * its own (for example "cloudflare-containers") from its entry point, before
 * the first sandbox is created:
 *
 * ```ts
 * registerSandboxProvider("cloudflare-containers", (config) => new ContainersSandbox(env, config));
 * ```
 *
 * A factory returns undefined when its provider is chosen but not configured,
 * which leaves the sandbox tools off (and may log why).
 */

import type { SandboxBackend, SandboxConfig } from "./types.js";

export type SandboxProviderFactory = (config: SandboxConfig) => SandboxBackend | undefined;

const providers = new Map<string, SandboxProviderFactory>();

/** Names that mean another provider. "aca" is the legacy name of Dynamic Sessions. */
const ALIASES: Record<string, string> = { aca: "aca-sessions" };

/** The provider a configured name refers to (aliases resolved). */
export function canonicalSandboxProvider(name: string): string {
  return Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
}

/** Register (or replace) the factory for a provider name. */
export function registerSandboxProvider(name: string, factory: SandboxProviderFactory): void {
  providers.set(canonicalSandboxProvider(name), factory);
}

/** Provider names registered so far. */
export function getSandboxProviders(): string[] {
  return [...providers.keys()];
}

/** The factory for a provider; throws for a name nobody registered. */
export function getSandboxProviderFactory(name: string): SandboxProviderFactory {
  const factory = providers.get(canonicalSandboxProvider(name));
  if (!factory) {
    throw new Error(`Unknown sandbox provider "${name}" (registered: ${getSandboxProviders().join(", ")})`);
  }
  return factory;
}
