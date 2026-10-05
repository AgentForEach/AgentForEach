/**
 * AgentForEach Skills Layer — Bedrock AgentCore Runtime settings
 *
 * The options the `aws-agentcore` backend (@agentforeach/platform-aws,
 * AwsAgentCoreSandbox) takes, built from the resolved sandbox config. The
 * AWS entry point registers the provider with them and the database:
 *
 * ```ts
 * registerSandboxProvider(AWS_AGENTCORE_PROVIDER, (config) =>
 *   new AwsAgentCoreSandbox({ ...agentcoreSandboxOptions(config), storage: getSharedStorage() }));
 * ```
 *
 * The options are inferred from the resolved config; no AWS SDK is imported.
 */

import type { SandboxConfig } from "./types.js";

export function agentcoreSandboxOptions(config: SandboxConfig) {
  if (!config.aws) {
    throw new Error('skills.sandbox.aws is resolved only for provider "aws-agentcore"');
  }
  return {
    ...config.aws,
    identifierStrategy: config.identifierStrategy,
    maxOutputChars: config.maxOutputChars,
    maxExportBytes: config.maxExportBytes,
  };
}

export type AgentCoreSandboxOptions = ReturnType<typeof agentcoreSandboxOptions>;
