import type { BackupResult } from "../sync/BackupResult";
import type { RestoreResult } from "../sync/RestoreResult";

/**
 * Event names that can be listened to on a Ganon instance.
 */
export type GanonEventName =
  | "hydrationComplete"
  | "syncComplete"
  | "restoreComplete";

/**
 * Payload type for each Ganon event.
 */
export interface GanonEventPayloadMap {
  hydrationComplete: RestoreResult;
  syncComplete: BackupResult;
  restoreComplete: RestoreResult;
}

/**
 * Callback type for a specific event.
 */
export type GanonEventListener<N extends GanonEventName> = (
  payload: GanonEventPayloadMap[N]
) => void;
