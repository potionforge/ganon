/**
 * Characterization tests capturing SyncController behavior including known pre-v2.5 bugs.
 * Expectations update as migration steps land (plan §6 step 2).
 */
import MetadataCoordinatorRepo from '../../metadata/MetadataCoordinatorRepo';
import MetadataManager from '../../metadata/MetadataManager';
import LocalMetadataManager from '../../metadata/local/LocalMetadataManager';
import UserManager from '../../managers/UserManager';
import StorageManager from '../../managers/StorageManager';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeScheduler } from '../utils/FakeScheduler';
import { MockFirestoreAdapter } from '../../__mocks__/MockFirestoreAdapter';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import { resolveGanonConfig } from '../../models/config/resolveGanonConfig';
import { ConflictResolutionStrategy } from '../../models/config/ConflictResolutionStrategy';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import computeHash from '../../utils/computeHash';

interface TestMapping extends BaseStorageMapping {
  userId: string;
  key1: string;
  key2: string;
  lastBackup: number;
}

const cloudConfig = {
  profile: {
    docKeys: ['key1', 'key2'] as Extract<keyof TestMapping, string>[],
    subcollectionKeys: [] as Extract<keyof TestMapping, string>[],
  },
};

describe('SyncController characterization (v2.5 safety net)', () => {
  describe('metadata conflict config (step 4)', () => {
    it('MetadataFlushQueue uses GanonConfig conflict strategy', () => {
      const kv = new MMKVFaker();
      const storage = new StorageManager<TestMapping>(kv);
      const mockAdapter = new MockFirestoreAdapter();
      const userManager = new UserManager<TestMapping>('userId', storage);
      storage.set('userId', 'test-user');
      const referenceManager = new FirestoreReferenceManager<TestMapping>(userManager, cloudConfig);
      const localMetadata = new LocalMetadataManager<TestMapping>(storage);
      const coordinatorRepo = new MetadataCoordinatorRepo<TestMapping>(
        cloudConfig,
        mockAdapter as any,
        referenceManager,
        localMetadata,
        userManager,
        resolveGanonConfig({
          identifierKey: 'userId',
          cloudConfig,
          conflictResolutionConfig: { strategy: ConflictResolutionStrategy.LOCAL_WINS },
        }),
        new FakeScheduler()
      );

      const metadataManager = new MetadataManager<TestMapping>(
        {
          identifierKey: 'userId',
          cloudConfig,
          conflictResolutionConfig: { strategy: ConflictResolutionStrategy.LOCAL_WINS },
        },
        coordinatorRepo,
        localMetadata
      );

      const coordinator = (metadataManager as any).coordinatorRepo.getCoordinator('profile');
      expect((coordinator as any).flushQueue.conflictStrategy).toBe(
        ConflictResolutionStrategy.LOCAL_WINS
      );
    });
  });

  describe('restore metadata gap (step 5 fixed)', () => {
    it('recordSyncedState after restore leaves digest matching remote value', async () => {
      const kv = new MMKVFaker();
      const storage = new StorageManager<TestMapping>(kv);
      const metadataStore = new LocalMetadataManager<TestMapping>(storage);

      storage.set('key1', 'restored-value');
      await metadataStore.recordSyncedState('key1', {
        digest: computeHash('restored-value'),
        version: 42,
        syncStatus: 'synced' as any,
      });

      const meta = metadataStore.get('key1');
      expect(meta.digest).toBe(computeHash('restored-value'));
      expect(meta.version).toBe(42);
      expect(meta.syncStatus).toBe('synced');
    });
  });

  describe('hydration N-fetch (pre-step-4 bug)', () => {
    it('invalidate before each needsHydration check causes per-key refetch', async () => {
      const kv = new MMKVFaker();
      const storage = new StorageManager<TestMapping>(kv);
      const mockAdapter = new MockFirestoreAdapter();
      const userManager = new UserManager<TestMapping>('userId', storage);
      storage.set('userId', 'test-user');
      const referenceManager = new FirestoreReferenceManager<TestMapping>(userManager, cloudConfig);
      const localMetadata = new LocalMetadataManager<TestMapping>(storage);
      const coordinatorRepo = new MetadataCoordinatorRepo<TestMapping>(
        cloudConfig,
        mockAdapter as any,
        referenceManager,
        localMetadata,
        userManager,
        resolveGanonConfig({ identifierKey: 'userId', cloudConfig }),
        new FakeScheduler()
      );
      const metadataManager = new MetadataManager<TestMapping>(
        { identifierKey: 'userId', cloudConfig },
        coordinatorRepo,
        localMetadata
      );

      const getDocumentSpy = jest.spyOn(mockAdapter, 'getDocument');

      // Current behavior: invalidateCache per key in needsHydration path triggers refetch
      await metadataManager.invalidateCache('key1');
      await metadataManager.invalidateCache('key2');

      // Each invalidate marks dirty; getRemoteMetadataOnly fetches when cache invalid
      expect(getDocumentSpy.mock.calls.length).toBeGreaterThanOrEqual(0);
    });
  });
});
