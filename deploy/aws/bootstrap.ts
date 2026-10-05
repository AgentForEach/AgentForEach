/**
 * Runs before any gateway module: lambda.ts imports it first.
 *
 * The host is installed here: a Lambda process is persistent (pools and
 * sockets are reused between invocations) but runs nothing after a handler
 * returns, and API Gateway ends a request after 30 s (`lambdaHostInfo`).
 *
 * The release is loaded by `loadRelease`, which every handler awaits before
 * the gateway loads: the function's release manifest from S3, its secrets
 * from Secrets Manager into process.env, and its agentforeach.json installed
 * as the config (a Lambda package carries none). Some gateway modules read
 * config and the environment as they load, so this must come first.
 */

import { awsReleaseLoader, lambdaHostInfo } from "@agentforeach/platform-aws";
import { installConfig } from "../../gateway/utils/config.js";
import { installHost } from "../../gateway/runtime/host.js";

installHost(lambdaHostInfo());

export const loadRelease = awsReleaseLoader({ installConfig });
