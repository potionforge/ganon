import SyncController from '../SyncController';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import MetadataManager from '../../metadata/MetadataManager';
import OperationRepo from '../OperationRepo';
import UserManager from '../../managers/UserManager';
import { GanonConfig } from '../../models/config/GanonConfig';
import { ConflictResolutionConfig } from '../../models/config/ConflictResolutionConfig';
import { ConflictResolutionStrategy } from '../../models/config/ConflictResolutionStrategy';
import { ConflictMergeStrategy } from '../../models/config/ConflictMergeStrategy';
import { SyncStatus } from '../../models/sync/SyncStatus';
import { ConflictInfo } from '../../models/sync/ConflictInfo';
import Log from '../../utils/Log';

// Mock dependencies
jest.mock('../../managers/StorageManager');
jest.mock('../../firestore/FirestoreManager');
jest.mock('../../metadata/MetadataManager');
jest.mock('../OperationRepo');
jest.mock('../../managers/UserManager');
jest.mock('../../utils/Log');

describe('SyncController Conflict Handling', () => {
  let syncController: SyncController<any>;
  let mockStorage: jest.Mocked<StorageManager<any>>;
  let mockFirestore: jest.Mocked<FirestoreManager<any>>;
  let mockMetadataManager: jest.Mocked<MetadataManager<any>>;
  let mockOperationRepo: jest.Mocked<OperationRepo<any>>;
  let mockUserManager: jest.Mocked<UserManager<any>>;
  let mockConfig: GanonConfig<any>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mock instances with proper constructors
    mockStorage = {
      set: jest.fn(),
      get: jest.fn(),
      remove: jest.fn()
    } as unknown as jest.Mocked<StorageManager<any>>;
    mockFirestore = {} as jest.Mocked<FirestoreManager<any>>;
    mockMetadataManager = {
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      updateSyncStatus: jest.fn()
    } as unknown as jest.Mocked<MetadataManager<any>>;
    mockOperationRepo = {} as jest.Mocked<OperationRepo<any>>;
    mockUserManager = {
      isUserLoggedIn: jest.fn().mockReturnValue(false),
      getCurrentUser: jest.fn().mockReturnValue(undefined)
    } as unknown as jest.Mocked<UserManager<any>>;

    // Setup mock config
    mockConfig = {
      identifierKey: 'userId',
      cloudConfig: {},
      conflictResolutionConfig: {
        strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
        mergeStrategy: ConflictMergeStrategy.DEEP_MERGE,
        notifyOnConflict: true,
        trackConflicts: true,
        maxTrackedConflicts: 100
      }
    };

    // Create SyncController instance
    syncController = new SyncController(
      mockStorage,
      mockFirestore,
      mockMetadataManager,
      mockOperationRepo,
      mockUserManager,
      mockConfig
    );
  });

  describe('conflict resolution configuration', () => {
    it('should use default conflict resolution config when not provided', () => {
      const configWithoutConflict: GanonConfig<any> = {
        identifierKey: 'userId',
        cloudConfig: {}
      };

      const controller = new SyncController(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithoutConflict
      );

      // Access private property for testing
      const conflictConfig = (controller as any)._conflictResolutionConfig;

      expect(conflictConfig.strategy).toBe(ConflictResolutionStrategy.LAST_MODIFIED_WINS);
      expect(conflictConfig.mergeStrategy).toBe(ConflictMergeStrategy.DEEP_MERGE);
      expect(conflictConfig.notifyOnConflict).toBe(true);
      expect(conflictConfig.trackConflicts).toBe(true);
      expect(conflictConfig.maxTrackedConflicts).toBe(100);
    });

    it('should merge provided conflict resolution config with defaults', () => {
      const customConfig: Partial<ConflictResolutionConfig> = {
        strategy: ConflictResolutionStrategy.LOCAL_WINS,
        notifyOnConflict: false
      };

      const configWithCustomConflict: GanonConfig<any> = {
        identifierKey: 'userId',
        cloudConfig: {},
        conflictResolutionConfig: customConfig
      };

      const controller = new SyncController(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithCustomConflict
      );

      const conflictConfig = (controller as any)._conflictResolutionConfig;

      expect(conflictConfig.strategy).toBe(ConflictResolutionStrategy.LOCAL_WINS);
      expect(conflictConfig.notifyOnConflict).toBe(false);
      expect(conflictConfig.mergeStrategy).toBe(ConflictMergeStrategy.DEEP_MERGE); // Should keep default
      expect(conflictConfig.trackConflicts).toBe(true); // Should keep default
    });
  });

  describe('conflict tracking', () => {
    it('should track conflicts when enabled', () => {
      const conflictInfo: ConflictInfo<any> = {
        key: 'test-key',
        localValue: { name: 'John' },
        remoteValue: { name: 'Jane' },
        localMetadata: {
          version: 1,
          digest: 'hash1',
          syncStatus: SyncStatus.Synced
        },
        remoteMetadata: {
          version: 2,
          digest: 'hash2'
        },
        resolutionStrategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
        detectedAt: Date.now(),
      };

      // Call private method for testing
      (syncController as any)._trackConflict(conflictInfo);

      const trackedConflicts = syncController.getTrackedConflicts();
      expect(trackedConflicts).toHaveLength(1);
      expect(trackedConflicts[0]).toEqual(conflictInfo);
    });

    it('should not track conflicts when disabled', async () => {
      const configWithoutTracking: GanonConfig<any> = {
        identifierKey: 'userId',
        cloudConfig: {},
        conflictResolutionConfig: {
          strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
          trackConflicts: false
        }
      };

      const controller = new SyncController(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithoutTracking
      );

      // Call _handleDataConflict which respects the trackConflicts setting
      await (controller as any)._handleDataConflict(
        'test-key',
        { name: 'John' },
        { name: 'Jane' },
        { version: 1, digest: 'hash1' },
        { version: 2, digest: 'hash2' }
      );

      const trackedConflicts = controller.getTrackedConflicts();
      expect(trackedConflicts).toHaveLength(0);
    });

    it('should limit tracked conflicts to maxTrackedConflicts', () => {
      const configWithLimit: GanonConfig<any> = {
        identifierKey: 'userId',
        cloudConfig: {},
        conflictResolutionConfig: {
          strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
          trackConflicts: true,
          maxTrackedConflicts: 2
        }
      };

      const controller = new SyncController(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithLimit
      );

      // Add 3 conflicts
      for (let i = 0; i < 3; i++) {
        const conflictInfo: ConflictInfo<any> = {
          key: `test-key-${i}`,
          localValue: { name: `John${i}` },
          remoteValue: { name: `Jane${i}` },
          localMetadata: {
            version: 1,
            digest: `hash1-${i}`,
            syncStatus: SyncStatus.Synced
          },
          remoteMetadata: {
            version: 2,
            digest: `hash2-${i}`
          },
          resolutionStrategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
          detectedAt: Date.now() + i,
        };

        (controller as any)._trackConflict(conflictInfo);
      }

      const trackedConflicts = controller.getTrackedConflicts();
      expect(trackedConflicts).toHaveLength(2);
      // Should keep the most recent ones
      expect(trackedConflicts[0].key).toBe('test-key-2');
      expect(trackedConflicts[1].key).toBe('test-key-1');
    });

    it('should clear tracked conflicts', () => {
      const conflictInfo: ConflictInfo<any> = {
        key: 'test-key',
        localValue: { name: 'John' },
        remoteValue: { name: 'Jane' },
        localMetadata: {
          version: 1,
          digest: 'hash1',
          syncStatus: SyncStatus.Synced
        },
        remoteMetadata: {
          version: 2,
          digest: 'hash2'
        },
        resolutionStrategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
        detectedAt: Date.now(),
      };

      (syncController as any)._trackConflict(conflictInfo);
      expect(syncController.getTrackedConflicts()).toHaveLength(1);

      syncController.clearTrackedConflicts();
      expect(syncController.getTrackedConflicts()).toHaveLength(0);
    });
  });

  describe('conflict notification', () => {
    it('should notify about conflicts when enabled', () => {
      const conflictInfo: ConflictInfo<any> = {
        key: 'test-key',
        localValue: { name: 'John' },
        remoteValue: { name: 'Jane' },
        localMetadata: {
          version: 1,
          digest: 'hash1',
          syncStatus: SyncStatus.Synced
        },
        remoteMetadata: {
          version: 2,
          digest: 'hash2'
        },
        resolutionStrategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
        detectedAt: Date.now(),
      };

      (syncController as any)._notifyConflict(conflictInfo);

      expect(Log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Data conflict notification for key test-key')
      );
      expect(Log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Conflict details')
      );
      expect(Log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Resolution strategy: last-modified-wins')
      );
    });

    it('should not notify about conflicts when disabled', async () => {
      const configWithoutNotification: GanonConfig<any> = {
        identifierKey: 'userId',
        cloudConfig: {},
        conflictResolutionConfig: {
          strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
          notifyOnConflict: false
        }
      };

      const controller = new SyncController(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithoutNotification
      );

      // Call _handleDataConflict which respects the notifyOnConflict setting
      await (controller as any)._handleDataConflict(
        'test-key',
        { name: 'John' },
        { name: 'Jane' },
        { version: 1, digest: 'hash1' },
        { version: 2, digest: 'hash2' }
      );

      expect(Log.warn).not.toHaveBeenCalled();
    });
  });

  describe('conflict detection and resolution', () => {
    it('should detect and resolve conflicts', async () => {
      const localValue = { name: 'John' };
      const remoteValue = { name: 'Jane' };
      const localMetadata = {
        version: 1,
        digest: 'hash1',
        syncStatus: SyncStatus.Synced
      };
      const remoteMetadata = {
        version: 2,
        digest: 'hash2'
      };

      const result = await (syncController as any)._checkAndResolveConflicts(
        'test-key',
        localValue,
        remoteValue,
        localMetadata,
        remoteMetadata
      );

      expect(result).toBe(true);
      expect(mockStorage.set).toHaveBeenCalledWith('test-key', remoteValue);
      expect(mockMetadataManager.set).toHaveBeenCalledWith(
        'test-key',
        expect.objectContaining({
          syncStatus: SyncStatus.Synced
        }),
        false // Don't schedule remote sync during hydration
      );
    });

    it('should return true when no conflict is detected', async () => {
      const value = { name: 'John' };
      const localMetadata = {
        version: 1,
        digest: 'hash1',
        syncStatus: SyncStatus.Synced
      };
      const remoteMetadata = {
        version: 1,
        digest: 'hash1'
      };

      const result = await (syncController as any)._checkAndResolveConflicts(
        'test-key',
        value,
        value, // Same value = no conflict
        localMetadata,
        remoteMetadata
      );

      expect(result).toBe(true);
      expect(mockStorage.set).not.toHaveBeenCalled();
    });
  });
});
