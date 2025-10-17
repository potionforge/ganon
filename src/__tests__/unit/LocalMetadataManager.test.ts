import LocalMetadataManager from '../../metadata/local/LocalMetadataManager';
import StorageManager from '../../managers/StorageManager';
import { SyncStatus } from '../../models/sync/SyncStatus';
import LocalSyncMetadata from '../../models/sync/LocalSyncMetadata';
import { METADATA_KEY } from '../../constants';

// Mock StorageManager
jest.mock('../../managers/StorageManager');

describe('LocalMetadataManager Tests', () => {
  let localMetadataManager: LocalMetadataManager<any>;
  let mockStorage: jest.Mocked<StorageManager<any>>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock storage
    mockStorage = {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
    } as any;

    // Create LocalMetadataManager instance
    localMetadataManager = new LocalMetadataManager(mockStorage);
  });

  // Helper function to set up internal data
  const setupInternalData = (data: any) => {
    // Access the private data property and set it directly
    (localMetadataManager as any).data = data;
  };

  describe('set method', () => {
    it('should update metadata with provided values', () => {
      // Arrange
      const key = 'testKey';
      const metadata: LocalSyncMetadata = {
        syncStatus: SyncStatus.Synced,
        digest: 'test-digest',
        version: 1234567890,
      };

      // Act
      localMetadataManager.set(key, metadata);

      // Assert
      expect(mockStorage.set).toHaveBeenCalledWith(METADATA_KEY, expect.any(Object));

      // Verify the stored data structure
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key]).toEqual({
        d: 'test-digest',
        v: 1234567890,
        s: SyncStatus.Synced,
      });
    });

    it('should use existing version when not provided', () => {
      // Arrange
      const key = 'testKey';

      // Set up existing metadata in internal data
      setupInternalData({
        [key]: {
          d: 'existing-digest',
          v: 1000,
          s: SyncStatus.Synced,
        }
      });

      const newMetadata = {
        syncStatus: SyncStatus.Pending,
        digest: 'new-digest',
        // version not provided
      } as Partial<LocalSyncMetadata>;

      // Act
      localMetadataManager.set(key, newMetadata as LocalSyncMetadata);

      // Assert
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key]).toEqual({
        d: 'new-digest',
        v: 1000, // Should preserve existing version
        s: SyncStatus.Pending,
      });
    });

    it('should preserve existing version when not provided', () => {
      // Arrange
      const key = 'testKey';
      const metadata = {
        syncStatus: SyncStatus.Synced,
        digest: 'test-digest',
        // version not provided
      } as Partial<LocalSyncMetadata>;

      // Act
      localMetadataManager.set(key, metadata as LocalSyncMetadata);

      // Assert
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key].v).toBe(0); // Should preserve existing version (0 for non-existent keys)
    });

    it('should merge with existing metadata', () => {
      // Arrange
      const key = 'testKey';

      // Set up existing metadata in internal data
      setupInternalData({
        [key]: {
          d: 'existing-digest',
          v: 1000,
          s: SyncStatus.Synced,
        }
      });

      const partialMetadata = {
        syncStatus: SyncStatus.Pending,
        // Only updating sync status, preserving digest and version
      } as Partial<LocalSyncMetadata>;

      // Act
      localMetadataManager.set(key, partialMetadata as LocalSyncMetadata);

      // Assert
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key]).toEqual({
        d: 'existing-digest', // Preserved
        v: 1000, // Preserved
        s: SyncStatus.Pending, // Updated
      });
    });
  });

  describe('updateSyncStatus method', () => {
    it('should preserve existing version and digest when updating sync status', () => {
      // Arrange
      const key = 'testKey';

      // Set up existing metadata in internal data
      setupInternalData({
        [key]: {
          d: 'existing-digest',
          v: 1000,
          s: SyncStatus.Synced,
        }
      });

      // Act
      localMetadataManager.updateSyncStatus(key, SyncStatus.Pending);

      // Assert
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key]).toEqual({
        d: 'existing-digest', // Preserved
        v: 1000, // Preserved
        s: SyncStatus.Pending, // Updated
      });
    });

    it('should handle case when no existing metadata', () => {
      // Arrange
      const key = 'testKey';

      // Act
      localMetadataManager.updateSyncStatus(key, SyncStatus.Pending);

      // Assert
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key]).toEqual({
        d: '', // Default empty digest
        v: expect.any(Number), // Should use Date.now()
        s: SyncStatus.Pending,
      });
    });

    it('should not update version when only sync status changes', () => {
      // Arrange
      const key = 'testKey';
      const originalVersion = 1000;

      // Set up existing metadata in internal data
      setupInternalData({
        [key]: {
          d: 'existing-digest',
          v: originalVersion,
          s: SyncStatus.Synced,
        }
      });

      // Act
      localMetadataManager.updateSyncStatus(key, SyncStatus.Pending);

      // Assert
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key].v).toBe(originalVersion); // Version should not change
    });
  });

  describe('get method', () => {
    it('should return metadata for existing key', () => {
      // Arrange
      const key = 'testKey';
      const expectedMetadata: LocalSyncMetadata = {
        syncStatus: SyncStatus.Synced,
        digest: 'test-digest',
        version: 1000,
      };

      // Set up existing metadata in internal data
      setupInternalData({
        [key]: {
          d: 'test-digest',
          v: 1000,
          s: SyncStatus.Synced,
        }
      });

      // Act
      const result = localMetadataManager.get(key);

      // Assert
      expect(result).toEqual(expectedMetadata);
    });

    it('should return default metadata for non-existent key', () => {
      // Arrange
      const key = 'nonExistentKey';

      // Act
      const result = localMetadataManager.get(key);

      // Assert
      expect(result).toEqual({
        digest: '',
        version: 0,
        syncStatus: SyncStatus.Synced,
      });
    });

    it('should handle corrupted metadata gracefully', () => {
      // Arrange
      const key = 'testKey';
      mockStorage.get.mockReturnValue('invalid-json');

      // Create new instance with corrupted data
      const corruptedManager = new LocalMetadataManager(mockStorage);

      // Act
      const result = corruptedManager.get(key);

      // Assert
      expect(result).toEqual({
        digest: '',
        version: 0,
        syncStatus: SyncStatus.Synced,
      });
    });
  });

  describe('has method', () => {
    it('should return true for existing key', () => {
      // Arrange
      const key = 'testKey';

      // Set up existing metadata in internal data
      setupInternalData({
        [key]: {
          d: 'test-digest',
          v: 1000,
          s: SyncStatus.Synced,
        }
      });

      // Act
      const result = localMetadataManager.has(key);

      // Assert
      expect(result).toBe(true);
    });

    it('should return false for non-existent key', () => {
      // Arrange
      const key = 'nonExistentKey';

      // Act
      const result = localMetadataManager.has(key);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('remove method', () => {
    it('should remove metadata for key', () => {
      // Arrange
      const key = 'testKey';

      // Set up existing metadata in internal data
      setupInternalData({
        [key]: {
          d: 'test-digest',
          v: 1000,
          s: SyncStatus.Synced,
        },
        otherKey: {
          d: 'other-digest',
          v: 2000,
          s: SyncStatus.Synced,
        }
      });

      // Act
      localMetadataManager.remove(key);

      // Assert
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key]).toBeUndefined();
      expect(storedData.otherKey).toBeDefined(); // Other keys should remain
    });
  });

  describe('edge cases', () => {
    it('should handle empty metadata object', () => {
      // Arrange
      const key = 'testKey';
      setupInternalData({});

      // Act
      const result = localMetadataManager.get(key);

      // Assert
      expect(result).toEqual({
        digest: '',
        version: 0,
        syncStatus: SyncStatus.Synced,
      });
    });

    it('should handle metadata with missing fields', () => {
      // Arrange
      const key = 'testKey';

      // Set up metadata with missing fields
      setupInternalData({
        [key]: {
          d: 'test-digest',
          // Missing v and s fields
        }
      });

      // Act
      const result = localMetadataManager.get(key);

      // Assert
      expect(result).toEqual({
        syncStatus: SyncStatus.Synced, // Default value
        digest: 'test-digest',
        version: undefined, // Missing field returns undefined
      });
    });

    it('should handle null values gracefully', () => {
      // Arrange
      const key = 'testKey';
      const metadata: LocalSyncMetadata = {
        syncStatus: SyncStatus.Synced,
        digest: '',
        version: 0,
      };

      // Act
      localMetadataManager.set(key, metadata);

      // Assert
      const storedData = mockStorage.set.mock.calls[0][1];
      expect(storedData[key]).toEqual({
        d: '',
        v: expect.any(Number), // Version gets updated to Date.now() when provided as 0
        s: SyncStatus.Synced,
      });
    });
  });
});
