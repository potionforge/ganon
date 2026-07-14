/**
 * Result of probing whether the current user has any cloud backup data.
 *
 * - `present` — at least one configured key has remote metadata
 * - `absent` — every checked key returned empty with no errors (genuine new / wiped account)
 * - `indeterminate` — one or more probe reads failed; must NOT be treated as empty
 *   (choosing backup would run destructive syncAll against an unknown cloud)
 */
export type RemoteDataProbeResult =
  | { status: 'present' }
  | { status: 'absent' }
  | { status: 'indeterminate'; reason: string };
