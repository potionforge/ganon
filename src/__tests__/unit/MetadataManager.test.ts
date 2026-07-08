import MetadataManager from '../../metadata/MetadataManager';
import KeyRouter from '../../routing/KeyRouter';
import { CloudBackupConfig } from '../../models/config/CloudBackupConfig';
import MetadataCoordinatorRepo from '../../metadata/MetadataCoordinatorRepo';
import LocalMetadataManager from '../../metadata/local/LocalMetadataManager';
import { GanonConfig } from '../../models/config/GanonConfig';
import Log from '../../utils/Log';
import { TestStorageMapping, MOCK_CLOUD_BACKUP_CONFIG } from '../../__mocks__/MockConfig';
import { resolveGanonConfig } from '../../models/config/resolveGanonConfig';

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
      {} as any,
      resolveGanonConfig({ identifierKey: 'email', cloudConfig: MOCK_CLOUD_BACKUP_CONFIG }),
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

  describe('KeyRouter integration', () => {
    const getKeyRouter = (manager: MetadataManager<TestStorageMapping>) =>
      (manager as any).keyRouter as KeyRouter<TestStorageMapping>;

    it('should correctly map docKeys to their documents', () => {
      const router = getKeyRouter(metadataManager);
      expect(router.route('user')?.document).toBe('user');
      expect(router.route('count')?.document).toBe('user');
      expect(router.route('notes')?.document).toBe('notes');
      expect(router.route('deletedExerciseKeys')?.document).toBe('exercises');
    });

    it('should correctly map subcollectionKeys to their documents', () => {
      const router = getKeyRouter(metadataManager);
      expect(router.route('settings')).toEqual({ document: 'user', kind: 'subcollection' });
      expect(router.route('exercises')).toEqual({ document: 'exercises', kind: 'subcollection' });
    });

    it('should handle empty cloudConfig', () => {
      const manager = new MetadataManager(
        { identifierKey: 'email', cloudConfig: {} },
        mockCoordinatorRepo,
        mockLocalMetadata
      );
      expect(getKeyRouter(manager).allCloudKeys()).toEqual([]);
    });

    it('should handle document with only docKeys', () => {
      const manager = new MetadataManager(
        { identifierKey: 'email', cloudConfig: { notes: { docKeys: ['notes'] } } },
        mockCoordinatorRepo,
        mockLocalMetadata
      );
      expect(getKeyRouter(manager).route('notes')?.document).toBe('notes');
    });

    it('should handle document with only subcollectionKeys', () => {
      const manager = new MetadataManager(
        { identifierKey: 'email', cloudConfig: { exercises: { subcollectionKeys: ['exercises'] } } },
        mockCoordinatorRepo,
        mockLocalMetadata
      );
      expect(getKeyRouter(manager).route('exercises')?.kind).toBe('subcollection');
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

    it('should not per-key invalidate during invalidateCacheForHydration (step 4)', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      await metadataManager.invalidateCacheForHydration(key);
      expect(mockCoordinator.invalidateCache).not.toHaveBeenCalled();
    });

    it('invalidateCacheForHydration is a no-op on failure path', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      await expect(metadataManager.invalidateCacheForHydration(key)).resolves.not.toThrow();
    });

    it('needsHydration delegates to coordinator without per-key invalidate', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      mockCoordinator.needsHydration.mockResolvedValue(true);
      const result = await metadataManager.needsHydration(key);
      expect(mockCoordinator.invalidateCache).not.toHaveBeenCalled();
      expect(mockCoordinator.needsHydration).toHaveBeenCalledWith(key);
      expect(result).toBe(true);
    });

    it('needsHydration when coordinator fails returns coordinator result', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      mockCoordinator.needsHydration.mockResolvedValue(false);
      const result = await metadataManager.needsHydration(key);
      expect(mockCoordinator.invalidateCache).not.toHaveBeenCalled();
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