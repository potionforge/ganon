/**
 * Outcome of {@link Ganon.login}.
 *
 * Ganon exposes *facts*, not policy: the caller receives what happened and the
 * evidence behind it, and decides what (if anything) to do next. This lets the
 * app distinguish "restore because the cloud has data" (`probe: 'present'`) from
 * "restore because we couldn't read the cloud" (`probe: 'indeterminate'`) — the
 * two look identical from `action` alone, but demand very different handling for
 * a fresh guest account whose local data hasn't been backed up yet.
 */
export type LoginAction = 'noop' | 'restore' | 'backup';

/**
 * The remote-data probe outcome that drove the login decision, or `skipped`
 * when no probe ran (app-reopen / same-user `noop`).
 * Mirrors {@link RemoteDataProbeResult} status values, plus `skipped`.
 */
export type LoginProbeStatus = 'present' | 'absent' | 'indeterminate' | 'skipped';

export interface LoginResult {
  /** What Ganon did: no-op (same user / app reopen), restored from cloud, or backed up local. */
  action: LoginAction;
  /**
   * The probe status that drove the decision.
   * - `present` — cloud has data; login restored it.
   * - `absent` — cloud is genuinely empty; login backed up local guest state.
   * - `indeterminate` — one or more probe reads failed; login refused the
   *   destructive backup arm and attempted a (possibly empty) restore instead.
   * - `skipped` — no probe ran (same-user reopen / `noop`). Callers must handle
   *   this consciously; it is not a fabricated `present`.
   */
  probe: LoginProbeStatus;
  /**
   * Number of keys actually pulled from cloud. Only meaningful for
   * `action: 'restore'`; `0` for backup/noop. Critically, a restore that
   * reached an empty or unreadable remote also reports `0` — combined with
   * `probe: 'indeterminate'` this is the signal that a guest shell may be
   * stranded locally (backed up nowhere) and needs app-side resolution.
   */
  restoredKeys: number;
  /**
   * Number of keys that failed during restore. `0` for backup/noop.
   * A `present` restore with `restoredKeys > 0` and `restoreFailedKeys > 0` is a
   * partial restore — the session is degraded, not clean.
   */
  restoreFailedKeys: number;
  /** Present only when `probe: 'indeterminate'`: the aggregated failure reason. */
  probeReason?: string;
}
