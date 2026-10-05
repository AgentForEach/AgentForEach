/**
 * AgentForEach Skills Layer — handing the browser back to the agent
 *
 * The handoff's write-lock, gateway side (ported from the AWS reference's
 * continuation.ts): while the user has the browser, the agent must not act
 * in the sandbox, so an answered handoff resumes the agent only once the
 * driver confirms the live view has ended. If it can't confirm, the run
 * doesn't resume, and the user can answer again. (Inside the sandbox, the
 * server can refuse the agent's commands and writes while the driver's
 * /ping reports a handoff.)
 */

import type { SandboxBackend } from "../sandbox/types.js";
import { parseDriverOutput } from "./handler.js";

export class BrowserHandoffNotEndedError extends Error {
  constructor() {
    super("The browser couldn't be handed back to the agent, so it hasn't continued. Press Done or Cancel again.");
    this.name = "BrowserHandoffNotEndedError";
  }
}

/** Ends the live view in the user's sandbox, and resolves only once the driver says it has. */
export async function endBrowserHandoff(sandbox: SandboxBackend, userId: string, sessionId: string): Promise<void> {
  let result;
  try {
    result = await sandbox.exec({ command: "afe-browser handoff_stop", timeout: 30 }, sandbox.resolveIdentifier(userId, sessionId));
  } catch {
    throw new BrowserHandoffNotEndedError();
  }
  if (result.exitCode !== 0 || !parseDriverOutput(result.stdout)?.ok) throw new BrowserHandoffNotEndedError();
}
