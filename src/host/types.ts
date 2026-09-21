/**
 * Shared shapes for both halves of dsh-service-runner.
 *
 * These types cross the wire as plain JSON (host route responses), so every
 * field must stay serializable — no functions, no class instances.
 */

/** Lifecycle of one managed service. */
export type ServiceStatus =
  /** Never started in this DSH process, or stopped cleanly. */
  | 'stopped'
  /** Spawned, waiting for the port (or the ready timeout) to fire. */
  | 'starting'
  /** Healthy: the expected port answered, or the process outlived the grace window. */
  | 'running'
  /** Stop requested; the process tree is being torn down. */
  | 'stopping'
  /** Exited on its own with a non-zero code, or failed to spawn. */
  | 'failed'

/** What kind of project a detected service belongs to (display badge only). */
export type ServiceLanguage = 'node' | 'java' | 'python' | 'docker' | 'custom'

/**
 * A persisted service entry.
 *
 * `id` is derived from workspace + name and stays stable across restarts so
 * logs and settings survive a DSH restart even after a re-detect.
 */
export interface ServiceDefinition {
  id: string
  /** Absolute path of the workspace root this service belongs to. */
  workspace: string
  /** Human-facing name shown in the panel. */
  name: string
  /** Full command line, executed through the platform shell. */
  command: string
  /** Working directory, relative to `workspace` (empty = workspace root). */
  cwd?: string
  /** Expected listening port — drives readiness detection and the panel badge. */
  port?: number
  language: ServiceLanguage
  /** True when this entry came from auto-detection (vs. hand-edited). */
  autoDetected: boolean
  /** Free-form note shown as the row tooltip. */
  note?: string
  env?: Record<string, string>
  /**
   * HTTP readiness probe, when the listening port alone is not enough.
   *
   * Any 2xx/3xx answer counts as ready. Unset falls back to the port probe.
   */
  healthUrl?: string
  /**
   * Extra exit codes to treat as a clean stop, on top of `0`.
   *
   * A signal-driven shutdown reports `128 + signal` (130 = SIGINT, 143 =
   * SIGTERM) and Windows reports `0xC000013A` when a console window is closed.
   * Those mean "stopped on purpose", not "crashed" — the convention systemd
   * (`SuccessExitStatus`) and process-compose (`success_exit_codes`) both use.
   */
  successExitCodes?: number[]
  /**
   * Command run before the process tree is torn down.
   *
   * Windows has no signals to send, so the default stop is a close request to
   * the whole tree plus a forced kill. A service that ships its own graceful
   * shutdown — `docker stop`, an admin endpoint, a REPL that wants `quit` —
   * declares that command here; it runs first and gets `stopTimeoutMs`, and the
   * tree is only forced afterwards. process-compose models the same thing as
   * `shutdown.command` + `shutdown.timeout_seconds`.
   */
  stopCommand?: string
  /** Budget for `stopCommand` (and the polite request), in ms. Default 10000. */
  stopTimeoutMs?: number
  /**
   * Stop only the process we spawned, not its whole tree.
   *
   * For a supervisor that cleans up its own children, killing the tree would
   * skip that cleanup.
   */
  stopParentOnly?: boolean
  /**
   * What to do when the process exits on its own.
   *
   * - `no` (default): leave it stopped.
   * - `on_failure`: restart after a failure exit code, up to `maxRestarts`.
   * - `always`: restart after any exit, including a clean one.
   *
   * A bounded, backed-off retry loop is what PM2's restart strategies and
   * process-compose's `availability` both implement: without a cap, a service
   * that crashes during startup would spin forever.
   */
  restart?: 'no' | 'on_failure' | 'always'
  /** Base delay before an automatic restart, in ms. Doubles per attempt. */
  backoffMs?: number
  /** Cap on automatic restarts per activation; `0` means unlimited. Default 3. */
  maxRestarts?: number
  /**
   * Services that must be up before this one starts, keyed by service **name**.
   *
   * Names are what the panel shows; ids are workspace-qualified and opaque. The
   * value is the condition to wait for:
   *
   * - `started` (default): the dependency has a live process.
   * - `healthy`: it reported ready (its port answered, or its health URL passed).
   * - `completed_successfully`: it ran to completion with exit code 0 — the
   *   "run this migration first" case.
   *
   * Unknown values fall back to `started`. process-compose models the same
   * conditions; Tilt calls it resource dependencies.
   */
  dependsOn?: Record<string, string>
}

/** Live process facts for one service. */
export interface ServiceRuntime {
  status: ServiceStatus
  pid?: number
  /** Epoch ms of the current/last run start. */
  startedAt?: number
  /** Epoch ms when the process exited. */
  exitedAt?: number
  exitCode?: number | null
  /** Last error surface (spawn failure, non-zero exit, ready timeout). */
  error?: string
  /** Epoch ms when the port first answered (or the fallback grace elapsed). */
  readyAt?: number
  /** Port actually observed in the process output, when it differs from the hint. */
  detectedPort?: number
}

/** One buffered log line. */
export interface LogLine {
  /** Monotonic per-service sequence, used by the client for incremental pulls. */
  seq: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  at: number
}

/** Definition + runtime + log cursor, as sent to the browser. */
export interface ServiceSnapshot {
  definition: ServiceDefinition
  runtime: ServiceRuntime
  /** Highest log seq currently buffered; the client asks for `after` this. */
  logSeq: number
}

/** All known services for one workspace. */
export interface WorkspaceSnapshot {
  workspace: string
  /** Display name for the workspace (its basename). */
  name: string
  services: ServiceSnapshot[]
}

/** A detection candidate that the user may accept into the service list. */
export interface DetectedService {
  name: string
  command: string
  cwd?: string
  port?: number
  language: ServiceLanguage
  note?: string
  /** Why the detector proposed this (shown in the UI). */
  reason: string
}

/** Result of scanning one workspace directory. */
export interface DetectResult {
  workspace: string
  candidates: DetectedService[]
  /** Detector findings that are not services (info surfaced to the user). */
  notes: string[]
}

/**
 * One process listening on a port.
 *
 * Lives in the shared types (not in the port inspector) so the browser half can
 * describe an owner without dragging host code into its bundle.
 */
export interface PortOwner {
  port: number
  pid: number
  name: string
  /** ISO timestamp of process start, when known. */
  startedAt?: string
  /** Full command line — the part that identifies an IDE debug session. */
  commandLine?: string
}
