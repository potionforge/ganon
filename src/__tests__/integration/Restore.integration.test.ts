/**
 * Step 5 acceptance: restore leaves device synced; no per-key metadata refetch.
 */
import SyncEngine from '../../sync/SyncEngine';
import MetadataManager from '../../metadata/MetadataManager';
import { SyncStatus } from '../../models/sync/SyncStatus';
import computeHash from '../../utils/computeHash';

describe('Restore integration (step 5)', () => {
  it('restore then syncAll produces zero pending operations', async () => {
    const remoteMeta = { d: computeHash('remote-1'), v: 10 };
    const mockStorage = {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(),
      clearAllData: jest.fn(),
    };
    const mockFirestore = {
      fetch: jest.fn().mockResolvedValue('remote-1'),
      backup: jest.fn(),
      delete: jest.fn(),
      syncValueWithDigest: jest.fn(),
      cloudConfig: {},
    };
    const mockMetadataManager = {
      hydrateMetadata: jest.fn().mockResolvedValue(undefined),
      getRemoteMetaForKey: jest.fn().mockReturnValue(remoteMeta),
      recordSyncedState: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      recordLocalChange: jest.fn(),
      updateSyncStatus: jest.fn(),
      isNeverSynced: jest.fn().mockReturnValue(false),
    };
    const mockOperationRepo = {
      addOperation: jest.fn(),
      processOperations: jest.fn().mockResolvedValue([]),
      hasPendingOperations: jest.fn().mockReturnValue(false),
    };
    const mockUserManager = {
      isUserLoggedIn: jest.fn().mockReturnValue(true),
      getCurrentUser: jest.fn().mockReturnValue('user-1'),
    };

    const syncEngine = new SyncEngine(
      mockStorage as any,
      mockFirestore as any,
      mockMetadataManager as any,
      mockOperationRepo as any,
      mockUserManager as any,
      {
        identifierKey: 'userId',
        cloudConfig: {
          profile: { docKeys: ['key1'], subcollectionKeys: [] },
        },
        autoStartSync: false,
      }
    );

    const restoreResult = await syncEngine.restore();
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.restoredKeys).toContain('key1');
    expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('key1', {
      digest: computeHash('remote-1'),
      version: remoteMeta.v,
      syncStatus: SyncStatus.Synced,
    });

    mockOperationRepo.processOperations.mockResolvedValue([]);
    const backupResult = await syncEngine.syncAll();
    expect(backupResult.success).toBe(true);
    expect(syncEngine.hasPendingOperations()).toBe(false);
    expect(mockOperationRepo.addOperation).not.toHaveBeenCalled();
  });

  it('hydrateMetadata is the only metadata fetch during restore (no per-key refetch)', async () => {
    const getRemoteMetadataOnly = jest.fn();
    const metadataManager = {
      hydrateMetadata: jest.fn().mockResolvedValue(undefined),
      getRemoteMetaForKey: jest.fn().mockReturnValue({ d: 'abc', v: 1 }),
      getRemoteMetadataOnly,
      recordSyncedState: jest.fn(),
      get: jest.fn(),
      isNeverSynced: jest.fn(),
    };

    const syncEngine = new SyncEngine(
      { get: jest.fn(), set: jest.fn(), remove: jest.fn(), contains: jest.fn(), clearAllData: jest.fn() } as any,
      { fetch: jest.fn().mockResolvedValue('value'), cloudConfig: {} } as any,
      metadataManager as any,
      { addOperation: jest.fn(), processOperations: jest.fn().mockResolvedValue([]) } as any,
      { isUserLoggedIn: () => true, getCurrentUser: () => 'u1' } as any,
      {
        identifierKey: 'userId',
        cloudConfig: { profile: { docKeys: ['key1', 'key2'], subcollectionKeys: [] } },
        autoStartSync: false,
      }
    );

    await syncEngine.restore();
    expect(metadataManager.hydrateMetadata).toHaveBeenCalledTimes(1);
    expect(getRemoteMetadataOnly).not.toHaveBeenCalled();
  });
});
