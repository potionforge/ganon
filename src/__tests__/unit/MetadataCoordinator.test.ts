import MetadataCoordinator from '../../metadata/remote/MetadataCoordinator';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import LocalMetadataManager from '../../metadata/local/LocalMetadataManager';
import UserManager from '../../managers/UserManager';
import { SyncStatus } from '../../models/sync/SyncStatus';
import { TestStorageMapping, MOCK_CLOUD_BACKUP_CONFIG } from '../../__mocks__/MockConfig';
import { REMOTE_METADATA_KEY } from '../../constants';
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import StorageManager from '../../managers/StorageManager';
import IUserManager from '../../models/interfaces/IUserManager';

// Mock dependencies
jest.mock('../../firestore/ref/FirestoreReferenceManager');
jest.mock('../../firestore/FirestoreAdapter');
jest.mock('../../metadata/local/LocalMetadataManager');
jest.mock('../../managers/UserManager');
jest.mock('../../managers/StorageManager');

describe('MetadataCoordinator Tests', () => {
  let coordinator: MetadataCoordinator<TestStorageMapping>;
  let mockReferenceManager: jest.Mocked<FirestoreReferenceManager<TestStorageMapping>>;
  let mockAdapter: jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
  let mockLocalMetadata: jest.Mocked<LocalMetadataManager<TestStorageMapping>>;
  let mockUserManager: jest.Mocked<UserManager<TestStorageMapping>>;
  let mockDocRef: jest.Mocked<FirebaseFirestoreTypes.DocumentReference>;
  let mockStorage: jest.Mocked<StorageManager<TestStorageMapping>>;
  let mockUserManagerInterface: jest.Mocked<IUserManager>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Setup mock document reference
    mockDocRef = {
      id: 'test-doc',
      path: 'test/path',
    } as any;

    // Setup mock storage
    mockStorage = new StorageManager() as jest.Mocked<StorageManager<TestStorageMapping>>;

    // Setup mock user manager interface
    mockUserManagerInterface = {
      getCurrentUser: jest.fn(),
      isUserLoggedIn: jest.fn().mockReturnValue(true)
    } as jest.Mocked<IUserManager>;

    // Setup mock dependencies
    mockReferenceManager = new FirestoreReferenceManager(
      mockUserManagerInterface,
      MOCK_CLOUD_BACKUP_CONFIG
    ) as jest.Mocked<FirestoreReferenceManager<TestStorageMapping>>;
    mockReferenceManager.getDocumentRef.mockReturnValue(mockDocRef);

    mockAdapter = new FirestoreAdapter({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG
    }) as jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
    mockAdapter.getDocument.mockResolvedValue({
      exists: true,
      data: () => ({ [REMOTE_METADATA_KEY]: {} })
    } as any);

    mockLocalMetadata = new LocalMetadataManager(mockStorage) as jest.Mocked<LocalMetadataManager<TestStorageMapping>>;
    mockUserManager = new UserManager('email' as keyof TestStorageMapping, mockStorage) as jest.Mocked<UserManager<TestStorageMapping>>;
    mockUserManager.isUserLoggedIn.mockReturnValue(true);

    // Create coordinator instance
    coordinator = new MetadataCoordinator(
      mockReferenceManager,
      mockAdapter,
      mockLocalMetadata,
      mockUserManager,
      'settings' // Using a valid key from TestStorageMapping
    );
  });

  afterEach(() => {
    if (coordinator) {
      coordinator.destroy();
    }
  });

  describe('Conflict Detection', () => {
    const createMetadata = (version: number, digest: string) => ({
      version,
      digest,
      syncStatus: SyncStatus.Synced
    });

    beforeEach(() => {
      // Clear pending keys before each test
      coordinator['cache'].pendingKeys.clear();
    });

    it('should not detect conflict for local changes', async () => {
      // Setup
      const key = 'settings' as keyof TestStorageMapping;
      const localMeta = createMetadata(2, 'local-digest');
      const remoteMeta = { v: 1, d: 'remote-digest' };

      mockLocalMetadata.get.mockReturnValue(localMeta);
      mockAdapter.getDocument.mockResolvedValue({
        exists: true,
        data: () => ({ [REMOTE_METADATA_KEY]: { [key]: remoteMeta } })
      } as any);

      // Act
      await coordinator.updateLocalMetadata(key, localMeta);
      await coordinator.syncToRemote();

      // Assert
      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          [REMOTE_METADATA_KEY]: expect.objectContaining({
            [key]: { d: 'local-digest', v: 2 }
          })
        }),
        expect.any(Object)
      );
    });

    it('should detect conflict for concurrent remote changes', async () => {
      // Setup
      const key = 'settings' as keyof TestStorageMapping;
      const localMeta = createMetadata(1, 'local-digest');
      const remoteMeta = { v: 2, d: 'remote-digest' };

      // First get remote metadata to populate cache
      mockAdapter.getDocument.mockResolvedValueOnce({
        exists: true,
        data: () => ({ [REMOTE_METADATA_KEY]: { [key]: remoteMeta } })
      } as any);

      // Then try to sync local changes
      mockLocalMetadata.get.mockReturnValue(localMeta);

      // Act
      await coordinator.getRemoteMetadata(); // First get remote data
      // Clear pending keys to simulate a fresh sync
      coordinator['cache'].pendingKeys.clear();
      await coordinator.updateLocalMetadata(key, localMeta); // Then try to update
      await coordinator.syncToRemote();

      // Assert - should use remote version since it's newer
      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          [REMOTE_METADATA_KEY]: expect.objectContaining({
            [key]: { d: 'remote-digest', v: 2 }
          })
        }),
        expect.any(Object)
      );
    });

    it('should not detect conflict during remote fetch', async () => {
      // Setup
      const key = 'settings' as keyof TestStorageMapping;
      const localMeta = createMetadata(1, 'local-digest');
      const remoteMeta = { v: 2, d: 'remote-digest' };

      mockLocalMetadata.get.mockReturnValue(localMeta);
      mockAdapter.getDocument.mockResolvedValue({
        exists: true,
        data: () => ({ [REMOTE_METADATA_KEY]: { [key]: remoteMeta } })
      } as any);

      // Act - fetch remote data
      await coordinator.getRemoteMetadata();

      // Assert - should update local metadata with remote version
      expect(mockLocalMetadata.set).not.toHaveBeenCalled();
    });

    it('should handle multiple pending changes correctly', async () => {
      // Setup
      const key1 = 'settings' as keyof TestStorageMapping;
      const key2 = 'notes' as keyof TestStorageMapping;
      const localMeta1 = createMetadata(2, 'local-digest-1');
      const localMeta2 = createMetadata(3, 'local-digest-2');
      const remoteMeta1 = { v: 1, d: 'remote-digest-1' };
      const remoteMeta2 = { v: 4, d: 'remote-digest-2' };

      // First get remote metadata to populate cache
      mockAdapter.getDocument.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          [REMOTE_METADATA_KEY]: {
            [key1]: remoteMeta1,
            [key2]: remoteMeta2
          }
        })
      } as any);

      // Then try to sync local changes
      mockLocalMetadata.get
        .mockReturnValueOnce(localMeta1)
        .mockReturnValueOnce(localMeta2);

      // Act
      await coordinator.getRemoteMetadata(); // First get remote data
      // Clear pending keys to simulate a fresh sync
      coordinator['cache'].pendingKeys.clear();
      await coordinator.updateLocalMetadata(key1, localMeta1);
      await coordinator.updateLocalMetadata(key2, localMeta2);
      await coordinator.syncToRemote();

      // Assert
      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          [REMOTE_METADATA_KEY]: expect.objectContaining({
            [key1]: { d: 'local-digest-1', v: 2 }, // Local wins (newer)
            [key2]: { d: 'remote-digest-2', v: 4 }  // Remote wins (newer)
          })
        }),
        expect.any(Object)
      );
    });
  });

  describe('Update Paths', () => {
    it('should handle local updates correctly', async () => {
      const key = 'settings' as keyof TestStorageMapping;
      const metadata = {
        version: 1,
        digest: 'test-digest',
        syncStatus: SyncStatus.Pending
      };

      await coordinator.updateLocalMetadata(key, metadata);

      expect(mockLocalMetadata.set).toHaveBeenCalledWith(key, metadata);
      expect(mockAdapter.setDocument).not.toHaveBeenCalled(); // Should be scheduled, not immediate
    });

    it('should handle remote updates correctly', async () => {
      const key = 'settings' as keyof TestStorageMapping;
      const remoteMetadata = {
        v: 2,
        d: 'remote-digest'
      };

      mockAdapter.getDocument.mockResolvedValue({
        exists: true,
        data: () => ({ [REMOTE_METADATA_KEY]: { [key]: remoteMetadata } })
      } as any);

      await coordinator.getRemoteMetadata([key]);

      expect(mockLocalMetadata.set).not.toHaveBeenCalled(); // Should not update local metadata during fetch
    });

    it('should handle sync status updates correctly', () => {
      const key = 'settings' as keyof TestStorageMapping;
      const status = SyncStatus.Pending;

      coordinator.updateSyncStatus(key, status);

      expect(mockLocalMetadata.updateSyncStatus).toHaveBeenCalledWith(key, status);
    });
  });

  describe('Error Handling', () => {
    it('should handle fetch errors gracefully', async () => {
      mockAdapter.getDocument.mockRejectedValue(new Error('Fetch failed'));

      await expect(coordinator.getRemoteMetadata()).rejects.toThrow('Fetch failed');
    });

    it('should handle sync errors gracefully', async () => {
      const key = 'settings' as keyof TestStorageMapping;
      const metadata = {
        version: 1,
        digest: 'test-digest',
        syncStatus: SyncStatus.Pending
      };

      // Setup mock document response for initial fetch
      mockAdapter.getDocument.mockResolvedValueOnce({
        exists: true,
        data: () => ({ [REMOTE_METADATA_KEY]: {} })
      } as any);

      // Setup mock local metadata
      mockLocalMetadata.get.mockReturnValue(metadata);

      // Then mock the sync error
      mockAdapter.setDocument.mockRejectedValueOnce(new Error('Sync failed'));

      await coordinator.updateLocalMetadata(key, metadata);
      await expect(coordinator.syncToRemote()).rejects.toThrow('Sync failed');
    });

    it('should not sync when user is not logged in', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(false);

      const key = 'settings' as keyof TestStorageMapping;
      const metadata = {
        version: 1,
        digest: 'test-digest',
        syncStatus: SyncStatus.Pending
      };

      await coordinator.updateLocalMetadata(key, metadata);
      await coordinator.syncToRemote();

      expect(mockAdapter.setDocument).not.toHaveBeenCalled();
    });
  });
}); 