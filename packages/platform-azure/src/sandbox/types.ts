/**
 * AgentForEach Azure pack — sandbox config and wire types
 *
 * What the two ACA sandbox clients read of the gateway's resolved sandbox
 * config (skills.sandbox; the gateway's SandboxConfig has these fields and
 * more), and the REST payloads of Dynamic Sessions.
 */

/** Resolved ACA Sandboxes settings. */
export interface AcaSandboxesConfig {
  subscriptionId: string;
  resourceGroup: string;
  sandboxGroup: string;
  endpoint: string;
  diskImage: string;
  diskImageId?: string;
  cpu: string;
  memory: string;
  disk?: string;
  autoSuspendSec: number;
  suspendMode: "Disk" | "Memory";
  autoDeleteDays: number;
  egressAllowHosts: string[];
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
}

/** What AcaSandboxesClient reads of the resolved sandbox config. */
export interface AcaSandboxesClientConfig {
  enabled: boolean;
  /** Required: the client throws without it. */
  sandboxes?: AcaSandboxesConfig;
  identifierStrategy: "userId" | "sessionId";
  networkAccess: "disabled" | "enabled";
  maxOutputChars?: number;
  maxExportBytes?: number;
}

/** What DynamicSessionsClient reads of the resolved sandbox config. */
export interface DynamicSessionsClientConfig {
  enabled: boolean;
  poolManagementEndpoint: string;
  /** Container type: "PythonLTS" or "CustomContainer" */
  containerType: "PythonLTS" | "CustomContainer";
  identifierStrategy: "userId" | "sessionId";
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  maxOutputChars?: number;
  maxExportBytes?: number;
}

// ============================================================================
// ACA Dynamic Sessions API types (REST payload shapes)
// ============================================================================

/** Request body for ACA code/execute endpoint. */
export interface AcaExecuteRequest {
  properties: {
    /** "inline" for direct code, "inputFiles" for uploaded files. */
    codeInputType: "inline";
    /** "synchronous" for blocking execution. */
    executionType: "synchronous";
    /** The code/command to execute. */
    code: string;
    /** Timeout in seconds (optional). */
    timeoutInSeconds?: number;
  };
}

/** Response body from ACA code/execute endpoint. */
export interface AcaExecuteResponse {
  $id?: string;
  properties: {
    $id?: string;
    status: "Success" | "Failure" | "Timeout";
    stdout: string;
    stderr: string;
    result?: unknown;
    executionTimeInMilliseconds: number;
  };
}

/** File info from ACA files listing. */
export interface AcaFileInfo {
  $id?: string;
  properties: {
    $id?: string;
    filename: string;
    size: number;
    lastModifiedTime: string;
  };
}

/** Response body from ACA files endpoint. */
export interface AcaFilesResponse {
  $id?: string;
  value: AcaFileInfo[];
}

// ============================================================================
// CustomContainer API types (direct HTTP to sandbox server)
// ============================================================================

/** Request body for CustomContainer /exec endpoint. */
export interface CustomExecRequest {
  command: string;
  timeout?: number;
}

/** Response body from CustomContainer /exec endpoint. */
export interface CustomExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

/** Request body for CustomContainer /files/write endpoint. */
export interface CustomFileWriteRequest {
  filename: string;
  content: string;
}

/** Response body from CustomContainer /files/write endpoint. */
export interface CustomFileWriteResponse {
  success: boolean;
  filename: string;
  sizeBytes: number;
  error?: string;
}

/** Request body for CustomContainer /files/read endpoint. */
export interface CustomFileReadRequest {
  filename: string;
  /** Set to "base64" for binary file reads. */
  encoding?: "base64";
}

/** Response body from CustomContainer /files/read endpoint. */
export interface CustomFileReadResponse {
  content: string;
  filename: string;
  sizeBytes: number;
  /** Present when encoding=base64 was requested. */
  encoding?: "base64";
  error?: string;
}

/** Response body from CustomContainer /files (list) endpoint. */
export interface CustomFileListResponse {
  files: Array<{
    filename: string;
    size: number;
    lastModified: string;
  }>;
  error?: string;
}

/** Response body from CustomContainer /health endpoint. */
export interface CustomHealthResponse {
  status: string;
  runtimes: Record<string, string>;
  workDir: string;
  arch: string;
  platform: string;
}
