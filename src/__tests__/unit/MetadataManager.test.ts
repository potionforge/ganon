import MetadataManager from '../../metadata/MetadataManager';
import { CloudBackupConfig } from '../../models/config/CloudBackupConfig';
import MetadataCoordinatorRepo from '../../metadata/MetadataCoordinatorRepo';
import LocalMetadataManager from '../../metadata/local/LocalMetadataManager';
import { GanonConfig } from '../../models/config/GanonConfig';
import Log from '../../utils/Log';
import { TestStorageMapping, MOCK_CLOUD_BACKUP_CONFIG } from '../../__mocks__/MockConfig';

// Mock the dependencies
jest.mock('../../metadata/MetadataCoordinatorRepo');
jest.mock('../../metadata/local/LocalMetadataManager');

describe('MetadataManager Tests', () => {
  let metadataManager: MetadataManager<TestStorageMapping>;
  let mockCoordinatorRepo: jest.Mocked<MetadataCoordinatorRepo<TestStorageMapping>>;
  let mockLocalMetadata: jest.Mocked<LocalMetadataManager<TestStorageMapping>>;
  let mockConfig: GanonConfig<TestStorageMapping>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Setup mock config using the shared mock config
    mockConfig = {
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG
    };

    // Setup mock dependencies
    mockCoordinatorRepo = new MetadataCoordinatorRepo(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    ) as jest.Mocked<MetadataCoordinatorRepo<TestStorageMapping>>;

    mockLocalMetadata = new LocalMetadataManager(
      {} as any
    ) as jest.Mocked<LocalMetadataManager<TestStorageMapping>>;

    // Create MetadataManager instance
    metadataManager = new MetadataManager(
      mockConfig,
      mockCoordinatorRepo,
      mockLocalMetadata
    );

    // Spy on Log.verbose to verify logging
    jest.spyOn(Log, 'verbose');
  });

  describe('_buildKeyToDocumentMap', () => {
    // Helper function to access private method
    const buildKeyToDocumentMap = (manager: MetadataManager<TestStorageMapping>) => {
      return (manager as any)._buildKeyToDocumentMap();
    };

    // Helper function to get the private map
    const getKeyToDocumentMap = (manager: MetadataManager<TestStorageMapping>) => {
      return (manager as any).keyToDocumentMap;
    };

    it('should correctly map docKeys to their documents', () => {
      buildKeyToDocumentMap(metadataManager);
      const map = getKeyToDocumentMap(metadataManager);

      // Verify user docKeys
      expect(map.get('user')).toBe('user');
      expect(map.get('count')).toBe('user');
      expect(map.get('docKey')).toBe('user');
      expect(map.get('nonExistentKey')).toBe('user');

      // Verify exercises docKeys
      expect(map.get('deletedExerciseKeys')).toBe('exercises');

      // Verify notes docKeys
      expect(map.get('notes')).toBe('notes');
    });

    it('should correctly map subcollectionKeys to their documents', () => {
      buildKeyToDocumentMap(metadataManager);
      const map = getKeyToDocumentMap(metadataManager);

      // Verify user subcollectionKeys
      expect(map.get('settings')).toBe('user');
      expect(map.get('stringValue')).toBe('user');
      expect(map.get('numberValue')).toBe('user');
      expect(map.get('booleanValue')).toBe('user');
      expect(map.get('arrayValue')).toBe('user');
      expect(map.get('largeArray')).toBe('user');
      expect(map.get('largeData')).toBe('user');
      expect(map.get('subcollectionKey')).toBe('user');

      // Verify exercises subcollectionKeys
      expect(map.get('exercises')).toBe('exercises');
      expect(map.get('startedExercises')).toBe('exercises');
    });

    it('should handle empty cloudConfig', () => {
      const emptyConfig: GanonConfig<TestStorageMapping> = {
        identifierKey: 'email',
        cloudConfig: {}
      };

      const manager = new MetadataManager(
        emptyConfig,
        mockCoordinatorRepo,
        mockLocalMetadata
      );

      buildKeyToDocumentMap(manager);
      const map = getKeyToDocumentMap(manager);
      expect(map.size).toBe(0);
    });

    it('should handle document with only docKeys', () => {
      const config: CloudBackupConfig<TestStorageMapping> = {
        notes: {
          docKeys: ['notes']
        }
      };

      const manager = new MetadataManager(
        { identifierKey: 'email', cloudConfig: config },
        mockCoordinatorRepo,
        mockLocalMetadata
      );

      buildKeyToDocumentMap(manager);
      const map = getKeyToDocumentMap(manager);
      expect(map.get('notes')).toBe('notes');
      expect(map.size).toBe(1);
    });

    it('should handle document with only subcollectionKeys', () => {
      const config: CloudBackupConfig<TestStorageMapping> = {
        exercises: {
          subcollectionKeys: ['exercises']
        }
      };

      const manager = new MetadataManager(
        { identifierKey: 'email', cloudConfig: config },
        mockCoordinatorRepo,
        mockLocalMetadata
      );

      buildKeyToDocumentMap(manager);
      const map = getKeyToDocumentMap(manager);
      expect(map.get('exercises')).toBe('exercises');
      expect(map.size).toBe(1);
    });

    it('should handle invalid keys gracefully', () => {
      const config: CloudBackupConfig<TestStorageMapping> = {
        user: {
          docKeys: ['user', null as any, undefined as any, ''],
          subcollectionKeys: ['settings', null as any, undefined as any, '']
        }
      };

      const manager = new MetadataManager(
        { identifierKey: 'email', cloudConfig: config },
        mockCoordinatorRepo,
        mockLocalMetadata
      );

      buildKeyToDocumentMap(manager);
      const map = getKeyToDocumentMap(manager);

      // Should only have valid keys
      expect(map.get('user')).toBe('user');
      expect(map.get('settings')).toBe('user');
      expect(map.size).toBe(2);
    });

    it('should clear existing mappings before rebuilding', () => {
      // First build with initial config
      buildKeyToDocumentMap(metadataManager);
      const initialMap = getKeyToDocumentMap(metadataManager);
      expect(initialMap.size).toBeGreaterThan(0);

      // Create new manager with empty config
      const emptyConfig: GanonConfig<TestStorageMapping> = {
        identifierKey: 'email',
        cloudConfig: {}
      };

      const newManager = new MetadataManager(
        emptyConfig,
        mockCoordinatorRepo,
        mockLocalMetadata
      );

      // Build map with empty config
      buildKeyToDocumentMap(newManager);
      const newMap = getKeyToDocumentMap(newManager);
      expect(newMap.size).toBe(0);
    });
  });

  describe('Hydration Operations', () => {
    let mockCoordinator: jest.Mocked<any>;

    beforeEach(() => {
      mockCoordinator = {
        invalidateCache: jest.fn().mockResolvedValue(undefined),
        needsHydration: jest.fn().mockResolvedValue(true),
        getRemoteMetadata: jest.fn().mockResolvedValue({}),
        updateLocalMetadata: jest.fn().mockResolvedValue(undefined),
        updateSyncStatus: jest.fn(),
        ensureConsistency: jest.fn().mockResolvedValue({}),
        syncToRemote: jest.fn().mockResolvedValue(undefined),
        cancelPendingOperations: jest.fn()
      };

      // Mock the coordinator repo to return our mock coordinator
      mockCoordinatorRepo.getCoordinator = jest.fn().mockReturnValue(mockCoordinator);
    });

    it('should force cache invalidation for hydration', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      
      await metadataManager.invalidateCacheForHydration(key);
      
      expect(mockCoordinator.invalidateCache).toHaveBeenCalled();
    });

    it('should handle cache invalidation failure gracefully', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      mockCoordinator.invalidateCache.mockRejectedValue(new Error('Cache invalidation failed'));
      
      await expect(metadataManager.invalidateCacheForHydration(key)).resolves.not.toThrow();
      
      expect(mockCoordinator.invalidateCache).toHaveBeenCalled();
    });

    it('should force cache invalidation during needsHydration check', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      mockCoordinator.needsHydration.mockResolvedValue(true);
      
      const result = await metadataManager.needsHydration(key);
      
      expect(mockCoordinator.invalidateCache).toHaveBeenCalled();
      expect(mockCoordinator.needsHydration).toHaveBeenCalledWith(key);
      expect(result).toBe(true);
    });

    it('should handle needsHydration with cache invalidation failure', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      mockCoordinator.invalidateCache.mockRejectedValue(new Error('Cache invalidation failed'));
      mockCoordinator.needsHydration.mockResolvedValue(false);
      
      const result = await metadataManager.needsHydration(key);
      
      expect(mockCoordinator.invalidateCache).toHaveBeenCalled();
      expect(mockCoordinator.needsHydration).toHaveBeenCalledWith(key);
      expect(result).toBe(false);
    });

    it('should handle needsHydration when coordinator is not found', async () => {
      const key = 'invalidKey' as Extract<keyof TestStorageMapping, string>;
      mockCoordinatorRepo.getCoordinator.mockReturnValue(undefined as any);
      
      const result = await metadataManager.needsHydration(key);
      
      expect(result).toBe(false);
      expect(mockCoordinator.invalidateCache).not.toHaveBeenCalled();
      expect(mockCoordinator.needsHydration).not.toHaveBeenCalled();
    });

    it('should handle invalidateCacheForHydration when coordinator is not found', async () => {
      const key = 'invalidKey' as Extract<keyof TestStorageMapping, string>;
      mockCoordinatorRepo.getCoordinator.mockReturnValue(undefined as any);
      
      await expect(metadataManager.invalidateCacheForHydration(key)).resolves.not.toThrow();
      
      expect(mockCoordinator.invalidateCache).not.toHaveBeenCalled();
    });

    it('should handle invalidateCache when coordinator is not found', async () => {
      const key = 'invalidKey' as Extract<keyof TestStorageMapping, string>;
      mockCoordinatorRepo.getCoordinator.mockReturnValue(undefined as any);
      
      await expect(metadataManager.invalidateCache(key)).resolves.not.toThrow();
      
      expect(mockCoordinator.invalidateCache).not.toHaveBeenCalled();
    });

    it('should handle set when coordinator is not found', async () => {
      const key = 'invalidKey' as Extract<keyof TestStorageMapping, string>;
      const metadata = { version: 1, digest: 'test', syncStatus: 'synced' as any };
      mockCoordinatorRepo.getCoordinator.mockReturnValue(undefined as any);
      
      await expect(metadataManager.set(key, metadata)).resolves.not.toThrow();
      
      expect(mockCoordinator.updateLocalMetadata).not.toHaveBeenCalled();
    });

    it('should handle updateSyncStatus when coordinator is not found', () => {
      const key = 'invalidKey' as Extract<keyof TestStorageMapping, string>;
      mockCoordinatorRepo.getCoordinator.mockReturnValue(undefined as any);
      
      expect(() => metadataManager.updateSyncStatus(key, 'pending' as any)).not.toThrow();
      
      expect(mockCoordinator.updateSyncStatus).not.toHaveBeenCalled();
    });

    it('should handle ensureConsistency when coordinator is not found', async () => {
      const key = 'invalidKey' as Extract<keyof TestStorageMapping, string>;
      mockCoordinatorRepo.getCoordinator.mockReturnValue(undefined as any);
      
      const result = await metadataManager.ensureConsistency(key);
      
      expect(result).toBeUndefined();
      expect(mockCoordinator.ensureConsistency).not.toHaveBeenCalled();
    });

    it('should handle getRemoteMetadataOnly when coordinator is not found', async () => {
      const key = 'invalidKey' as Extract<keyof TestStorageMapping, string>;
      mockCoordinatorRepo.getCoordinator.mockReturnValue(undefined as any);
      
      const result = await metadataManager.getRemoteMetadataOnly(key);
      
      expect(result).toBeUndefined();
      expect(mockCoordinator.getRemoteMetadata).not.toHaveBeenCalled();
    });
  });
});