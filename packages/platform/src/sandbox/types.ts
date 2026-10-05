/**
 * Sandbox port: a private, per-user (or per-conversation) machine that runs
 * model-written commands and keeps files under /mnt/data.
 *
 * A backend implements `SandboxBackend` for one product (ACA Sandboxes, ACA
 * Dynamic Sessions, Cloudflare Containers...) and declares what it can do in
 * `capabilities`, so callers check a capability instead of a class.
 */

/** What a backend can do beyond the core exec and file calls. */
export interface SandboxCapabilities {
  /** The browser (Chromium + the afe-browser driver, docs/Browser.md) can run in this sandbox. */
  browser: boolean;
  /**
   * Credentials can be injected by an egress proxy outside the sandbox
   * (`setEgressCredentials`), so a secret never enters it. Without this,
   * callers pass credentials as environment variables instead.
   */
  egressCredentials: boolean;
  /**
   * What survives while the sandbox is idle:
   *   - "none": nothing; the session is destroyed after a cooldown;
   *   - "data": the files under /mnt/data only (copied out and back, so
   *     packages installed elsewhere and running processes are gone);
   *   - "disk": files (on /mnt/data and elsewhere on its disk);
   *   - "memory": files, and running processes and memory too.
   */
  persistence: "none" | "data" | "disk" | "memory";
  /**
   * How much of /mnt/data persistence keeps, when it is bounded (an archive
   * of /mnt/data stored outside the sandbox). A call that leaves /mnt/data
   * over either bound fails with SandboxPersistenceLimitError and the last
   * saved files stay; nothing is saved cut short. Absent: no bound.
   */
  persistenceLimits?: SandboxPersistenceLimits;
}

/** The bounds on what `persistence` keeps (see SandboxCapabilities.persistenceLimits). */
export interface SandboxPersistenceLimits {
  /** Total bytes of the regular files under /mnt/data. */
  maxBytes: number;
  /** Files, directories and links under /mnt/data. */
  maxFiles: number;
}

/** Arguments for running a shell command (the `sandbox_exec` tool). */
export interface SandboxExecArgs {
  /** Shell command(s), run as `bash -c "<command>"` inside the sandbox. */
  command: string;
  /** Timeout in seconds; the backend applies its default and cap. */
  timeout?: number;
}

/** Result of a sandboxed shell command. */
export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code (0 = success). */
  exitCode: number;
  timedOut: boolean;
  /** Whether output was truncated. */
  truncated: boolean;
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
  /** The sandbox identifier the command ran in. */
  sessionId: string;
}

/** Arguments for writing a file. */
export interface SandboxFileWriteArgs {
  /** Filename, stored as /mnt/data/<filename>. */
  filename: string;
  /** File content (text). */
  content: string;
  /** Content type hint (default: from the extension). */
  contentType?: string;
}

export interface SandboxFileWriteResult {
  success: boolean;
  filename: string;
  sizeBytes: number;
  sessionId: string;
}

/** Arguments for reading a file from /mnt/data. */
export interface SandboxFileReadArgs {
  filename: string;
}

export interface SandboxFileReadResult {
  /** File content (text), at most the sandbox's output limit. */
  content: string;
  filename: string;
  /** Bytes read (the whole file unless `truncated`). */
  sizeBytes: number;
  /** True when the file was longer than the content returned. */
  truncated?: boolean;
  sessionId: string;
}

/** A file in /mnt/data. */
export interface SandboxFileInfo {
  filename: string;
  size: number;
  /** Last modified time (ISO string). */
  lastModified: string;
}

/** Result of reading a file as base64. */
export interface SandboxFileReadBinaryResult {
  contentBase64: string;
  filename: string;
  /** File size in bytes (before encoding). */
  sizeBytes: number;
  sessionId: string;
}

/** Result of exporting a file (uploaded, with a time-limited download URL). */
export interface SandboxFileExportResult {
  success: boolean;
  downloadUrl: string;
  filename: string;
  sizeBytes: number;
  /** When the download URL expires (ISO timestamp). */
  expiresAt: string;
  sessionId: string;
}

/** A header the egress proxy sets on the sandbox's requests to `hosts`. */
export interface EgressCredential {
  /** Credential key, used to name the rule (never the value). */
  key: string;
  hosts: string[];
  header: string;
  /** Final header value, format already applied. */
  value: string;
}

/**
 * What the sandbox tools need from a backend. Files live under /mnt/data.
 * A sandbox is addressed by an identifier from `resolveIdentifier` (one per
 * user, or one per conversation).
 */
export interface SandboxBackend {
  readonly capabilities: SandboxCapabilities;

  exec(args: SandboxExecArgs, sessionIdentifier: string): Promise<SandboxExecResult>;
  fileWrite(args: SandboxFileWriteArgs, sessionIdentifier: string): Promise<SandboxFileWriteResult>;
  fileRead(args: SandboxFileReadArgs, sessionIdentifier: string): Promise<SandboxFileReadResult>;
  fileList(sessionIdentifier: string): Promise<SandboxFileInfo[]>;
  fileReadBinary(args: SandboxFileReadArgs, sessionIdentifier: string): Promise<SandboxFileReadBinaryResult>;
  /**
   * Replace the env vars later exec calls in the same sandbox get: the whole
   * set, so a var left out (a revoked credential) is gone.
   */
  setEnv(vars: Record<string, string>, sessionIdentifier: string): Promise<void>;
  /**
   * Replace the credentials the egress proxy injects into this sandbox's
   * outbound requests (an empty list clears them). Needs
   * `capabilities.egressCredentials`; other backends reject the call.
   */
  setEgressCredentials(credentials: EgressCredential[], sessionIdentifier: string): Promise<void>;
  /**
   * Delete every sandbox a user has (and with it their files and snapshots),
   * across all their conversations; returns how many. Account erasure calls
   * this. A backend whose sandboxes keep nothing (`persistence: "none"`)
   * returns 0.
   */
  deleteUserSandboxes(userId: string): Promise<number>;
  /**
   * What deleteUserSandboxes leaves behind in this configuration, if
   * anything (e.g. snapshots left to expire), for the erasure report.
   */
  readonly erasureNotes?: readonly string[];
  resolveIdentifier(userId: string, sessionId?: string): string;
  /** Whether the backend is configured well enough to use. */
  isReady(): boolean;
}

/** The error a backend throws for a call its capabilities exclude. */
export class SandboxUnsupportedError extends Error {
  constructor(operation: string, backend: string) {
    super(`${backend}: ${operation} is not supported by this sandbox backend`);
    this.name = "SandboxUnsupportedError";
  }
}

/**
 * The error a backend throws when a call leaves /mnt/data over its
 * persistence limits (SandboxCapabilities.persistenceLimits): the call's
 * changes were not saved, and the sandbox keeps its last saved files.
 */
export class SandboxPersistenceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPersistenceLimitError";
  }
}
