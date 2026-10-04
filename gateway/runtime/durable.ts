/**
 * AgentForEach Runtime — Durable work
 *
 * The platform's Durable implementation (jobs, waits, alarms). A platform's
 * entry point installs it at startup (`installDurable`), after registering
 * the gateway's kinds (`workflows.ts`) with its pack. Without one, nothing
 * durable can start: background chat turns, HITL waits and the cron
 * scheduler need it, and callers check `hasDurable()` where they can fall
 * back.
 */

import type { Durable } from "@agentforeach/platform";

let installed: Durable | undefined;

/** Called once by a platform's entry point, before serving requests. */
export function installDurable(durable: Durable): void {
  installed = durable;
}

export function hasDurable(): boolean {
  return installed !== undefined;
}

/** The installed Durable implementation. Throws when none is installed. */
export function durable(): Durable {
  if (!installed) throw new Error("No durable runtime is installed on this host");
  return installed;
}

/** For tests: install a Durable, or none. */
export function setDurableForTests(durable: Durable | undefined): void {
  installed = durable;
}
