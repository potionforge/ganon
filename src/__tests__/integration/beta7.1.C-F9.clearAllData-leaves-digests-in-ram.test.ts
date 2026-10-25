/**
 * Finding: C-F9   Severity: Medium
 * Mechanism: MetadataStore loads `_sync_metadata_` into RAM once (_load at construction) and every _persist
 *   writes the whole RAM map back. Ganon.clearAllData() (public API) -> StorageManager.clearAllData() wipes
 *   the key from disk but MetadataStore.data is untouched (MetadataManager.ts:193 says so). RAM and disk now
 *   disagree: get()/isNeverSynced() still report the old digests, and the next unrelated metadata write
 *   resurrects every stale digest onto disk — the Ticket B shape ("digests left in RAM") for the
 *   clearAllData-without-logout path.
 * Targets: src/metadata/local/MetadataStore.ts:18-20 (_load once), :79-89 (_persist writes whole map)
 *          src/metadata/MetadataManager.ts:190-196 (clear only on cancelPendingOperations)
 *          call site: src/Ganon.ts:419-426
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import Ganon from '../../Ganon';
import { GanonConfig } from '../../models/config/GanonConfig';
import { SyncStatus } from '../../models/sync/SyncStatus';
import { METADATA_KEY } from '../../constants';
import {
  SIX_TWO_CLOUD_CONFIG,
  SIX_TWO_USER,
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
} from '../utils/sixTwoIntegrationHarness';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
};

let harness = createSixTwoStack(baseConfig);

jest.mock('../../factory/DependencyFactory', () =>
  jest.fn().mockImplementation(() => ({
    getDependencies: () => ({
      storageManager: harness.storage,
      syncEngine: harness.syncEngine,
      firestoreManager: harness.firestoreManager,
      networkMonitor: harness.networkMonitor,
      userManager: harness.userManager,
      keyRouter: harness.keyRouter,
      metadataManager: harness.metadataManager,
      operationRepo: harness.operationRepo,
      firestoreAdapter: harness.adapter,
      referenceManager: undefined,
      cacheController: undefined,
      metadataStore: undefined,
      localMetadataManager: undefined,
    }),
  }))
);

type PersistedMeta = Record<string, { d: string; v: number; s?: string }> | undefined;

describe('C-F9: clearAllData() wipes digests on disk but not in RAM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack(baseConfig);
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('after clearAllData() the metadata store agrees with disk and does not resurrect old digests', async () => {
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    await ganon.login(SIX_TWO_USER); // restore seeds alpha/beta/gamma digests

    const before = harness.storage.get(METADATA_KEY as keyof SixTwoStorage) as unknown as PersistedMeta;
    expect(before?.alpha?.d).toBeTruthy();
    expect(harness.metadataManager.isNeverSynced('alpha')).toBe(false);

    ganon.clearAllData();

    // Disk is clear...
    expect(harness.storage.get(METADATA_KEY as keyof SixTwoStorage)).toBeUndefined();
    // ...so RAM must agree.
    expect(harness.metadataManager.isNeverSynced('alpha')).toBe(true);

    // And an unrelated metadata write must not write the pre-clear digests back to disk.
    harness.metadataManager.updateSyncStatus('beta', SyncStatus.Pending);
    const after = harness.storage.get(METADATA_KEY as keyof SixTwoStorage) as unknown as PersistedMeta;
    expect(after?.alpha).toBeUndefined();

    ganon.destroy();
  });
});
