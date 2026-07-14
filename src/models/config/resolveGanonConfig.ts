import { GanonConfig } from './GanonConfig';
import { BaseStorageMapping } from '../storage/BaseStorageMapping';
import { ConflictResolutionConfig } from './ConflictResolutionConfig';
import { ConflictResolutionStrategy } from './ConflictResolutionStrategy';
import { ConflictMergeStrategy } from './ConflictMergeStrategy';
import { IntegrityFailureConfig } from './IntegrityFailureConfig';
import { IntegrityFailureRecoveryStrategy } from './IntegrityFailureRecoveryStrategy';
import { DigestReadMode } from '../../metadata/digest/selectRemoteDigest';

export interface ResolvedGanonConfig<T extends BaseStorageMapping> extends GanonConfig<T> {
  /** Resolved default: true when omitted. Controls sync interval, hydration on init/login, and remote metadata flush scheduling. */
  autoStartSync: boolean;
  metadataCacheMaxAgeMs: number;
  metadataFlushDebounceMs: number;
  metadataBatchSize: number;
  conflictResolutionConfig: Required<ConflictResolutionConfig>;
  integrityFailureConfig: Required<IntegrityFailureConfig>;
  digestReadMode: DigestReadMode;
  legacyMetadataWrites: boolean;
}

const DEFAULT_METADATA_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_METADATA_FLUSH_DEBOUNCE_MS = 1000;
const DEFAULT_METADATA_BATCH_SIZE = 50;

export function resolveGanonConfig<T extends BaseStorageMapping>(
  config: GanonConfig<T>
): ResolvedGanonConfig<T> {
  const conflictDefaults: Required<ConflictResolutionConfig> = {
    strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
    mergeStrategy: ConflictMergeStrategy.DEEP_MERGE,
    notifyOnConflict: true,
    trackConflicts: true,
    maxTrackedConflicts: 100,
  };

  const integrityDefaults: Required<IntegrityFailureConfig> = {
    maxRetries: 3,
    retryDelay: 1000,
    strategy: IntegrityFailureRecoveryStrategy.USE_LOCAL,
    notifyOnFailure: true,
  };

  return {
    ...config,
    autoStartSync: config.autoStartSync ?? true,
    metadataCacheMaxAgeMs: DEFAULT_METADATA_CACHE_MAX_AGE_MS,
    metadataFlushDebounceMs: DEFAULT_METADATA_FLUSH_DEBOUNCE_MS,
    metadataBatchSize: DEFAULT_METADATA_BATCH_SIZE,
    digestReadMode: config.digestReadMode ?? 'dual',
    legacyMetadataWrites: config.legacyMetadataWrites ?? true,
    conflictResolutionConfig: {
      ...conflictDefaults,
      ...config.conflictResolutionConfig,
    },
    integrityFailureConfig: {
      ...integrityDefaults,
      ...config.integrityFailureConfig,
    },
  };
}
