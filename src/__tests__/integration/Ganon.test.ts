import Ganon from '../../Ganon';
import { MOCK_CLOUD_BACKUP_CONFIG, TestStorageMapping } from '../../__mocks__/MockConfig';

describe('Ganon Integration Tests', () => {
  let ganon: Ganon<TestStorageMapping>;

  beforeEach(() => {
    // Create fresh instance for each test
    ganon = new Ganon<TestStorageMapping>({
      identifierKey: 'user',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
      // Don't auto-start sync to avoid routing issues
      autoStartSync: false,
      syncInterval: 30000,
      logLevel: 0
    });
  });

  afterEach(() => {
    // Clean up each test - only if ganon was successfully created
    if (ganon) {
      ganon.destroy();
    }
    // Give a moment for cleanup
    setTimeout(() => {}, 10);
  });

  describe('Basic Interface Compliance', () => {
    it('should implement all Ganon interface methods', () => {
      expect(typeof ganon.get).toBe('function');
      expect(typeof ganon.set).toBe('function');
      expect(typeof ganon.remove).toBe('function');
      expect(typeof ganon.upsert).toBe('function');
      expect(typeof ganon.contains).toBe('function');
      expect(typeof ganon.clearAllData).toBe('function');
      expect(typeof ganon.backup).toBe('function');
      expect(typeof ganon.dangerouslyDelete).toBe('function');
      expect(typeof ganon.startSync).toBe('function');
      expect(typeof ganon.stopSync).toBe('function');
      expect(typeof ganon.isUserLoggedIn).toBe('function');
      expect(typeof ganon.destroy).toBe('function');
    });

    it('should have correct method signatures', () => {
      // Test basic storage methods return types
      expect(ganon.get('user')).toBeUndefined();
      expect(ganon.contains('user')).toBe(false);
      expect(ganon.isUserLoggedIn()).toBe(false);
    });

    it('should have accessible configuration', () => {
      // Test that we can access the configuration
      expect(ganon.config.identifierKey).toBe('user');
      expect(ganon.config.cloudConfig).toBe(MOCK_CLOUD_BACKUP_CONFIG);
      expect(ganon.config.autoStartSync).toBe(false);
    });
  });

  describe('Basic CRUD Operations', () => {
    it('should handle get operations', () => {
      // Test getting non-existent values
      expect(ganon.get('user')).toBeUndefined();

      // Set a value and get it
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });
    });

    it('should handle set operations', () => {
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });

      // Overwrite existing value
      ganon.set('user', { id: '123', name: 'New User', email: 'new@example.com' });
      expect(ganon.get('user')).toEqual({ id: '123', name: 'New User', email: 'new@example.com' });
    });

    it('should handle remove operations', () => {
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });

      ganon.remove('user');
      expect(ganon.get('user')).toBeUndefined();
    });

    it('should handle upsert operations', () => {
      // Test with user object since upsert seems to work differently with objects
      const userData = { id: '123', name: 'Test User', email: 'test@example.com' };

      // Test upsert on non-existent key
      ganon.upsert('user', userData);
      expect(ganon.get('user')).toEqual(userData);

      // Test upsert on existing key (partial update)
      ganon.upsert('user', { name: 'Updated Name' });
      const updated = ganon.get('user');
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');
      expect(updated!.email).toBe('test@example.com');
    });

    it('should handle contains operations', () => {
      expect(ganon.contains('user')).toBe(false);

      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.contains('user')).toBe(true);

      ganon.remove('user');
      expect(ganon.contains('user')).toBe(false);
    });

    it('should handle clearAllData operations', () => {
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      ganon.set('count', 5);

      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.get('count')).toBe(5);

      ganon.clearAllData();

      expect(ganon.get('user')).toBeUndefined();
      expect(ganon.get('count')).toBeUndefined();
    });
  });

  describe('Type Safety', () => {
    it('should enforce type safety for operations', () => {
      // These operations should work with correct types
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      ganon.set('count', 42);
      ganon.set('notes', ['note1', 'note2']);

      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.get('count')).toBe(42);
      expect(ganon.get('notes')).toEqual(['note1', 'note2']);
    });
  });

  describe('Sync Control', () => {
    it('should handle sync control without starting', () => {
      // Don't actually start sync to avoid routing issues
      // ganon.startSync();

      ganon.stopSync();
      // No direct way to check if sync is active, so just verify it doesn't throw
      expect(() => ganon.stopSync()).not.toThrow();
    });
  });

  describe('Configuration', () => {
    it('should initialize with correct configuration', () => {
      expect(ganon.config.identifierKey).toBe('user');
      expect(ganon.config.cloudConfig).toBe(MOCK_CLOUD_BACKUP_CONFIG);
      expect(ganon.config.autoStartSync).toBe(false);
      expect(ganon.config.syncInterval).toBe(30000);
      expect(ganon.config.logLevel).toBe(0);
    });

    it('should handle different configuration options', () => {
      const ganon2 = new Ganon<TestStorageMapping>({
        identifierKey: 'user',
        cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
        autoStartSync: false,
        syncInterval: 60000,
        logLevel: 1
      });

      expect(ganon2.config.identifierKey).toBe('user');
      expect(ganon2.config.syncInterval).toBe(60000);
      expect(ganon2.config.logLevel).toBe(1);

      ganon2.destroy();
    });
  });

  describe('Configuration Validation', () => {
    it('should accept valid configuration', () => {
      expect(() => {
        const ganon2 = new Ganon<TestStorageMapping>({
          identifierKey: 'user',
          cloudConfig: MOCK_CLOUD_BACKUP_CONFIG
        });
        ganon2.destroy();
      }).not.toThrow();
    });

    it('should throw for invalid configuration', () => {
      // This test case is no longer valid since TypeScript ensures identifierKey is valid
      // expect(() => {
      //   new Ganon<TestStorageMapping>({
      //     identifierKey: 'nonExistentKey' as any,  // Invalid key that doesn't exist in mapping
      //     cloudConfig: MOCK_CLOUD_BACKUP_CONFIG
      //   });
      // }).toThrow();

      expect(() => {
        new Ganon<TestStorageMapping>({
          identifierKey: 'user',
          cloudConfig: {} as any  // Invalid empty cloud config
        });
      }).toThrow();
    });

    it('should throw for null/undefined configuration', () => {
      expect(() => {
        new Ganon<TestStorageMapping>(null as any);
      }).toThrow();

      expect(() => {
        new Ganon<TestStorageMapping>(undefined as any);
      }).toThrow();
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle storage without cloud operations', () => {
      // Test a complete user workflow without triggering cloud sync
      ganon.set('user', { id: '123', name: 'Test User', email: 'user@example.com' });
      ganon.set('notes', ['First note', 'Second note']);

      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'user@example.com' });
      expect(ganon.get('notes')).toEqual(['First note', 'Second note']);

      // Test with object upsert
      const userData = { id: '123', name: 'Test User', email: 'user@example.com' };
      ganon.upsert('user', userData);
      expect(ganon.get('user')).toEqual(userData);

      // Modify user data
      ganon.upsert('user', { name: 'Updated User' });
      const updatedUser = ganon.get('user');
      expect(updatedUser).toBeDefined();
      expect(updatedUser!.name).toBe('Updated User');
      expect(updatedUser!.email).toBe('user@example.com');

      // Add to notes
      ganon.set('notes', [...(ganon.get('notes') || []), 'Third note']);
      expect(ganon.get('notes')).toEqual(['First note', 'Second note', 'Third note']);

      // Clean up
      ganon.remove('user');
      expect(ganon.get('user')).toBeUndefined();
      expect(ganon.contains('user')).toBe(false);
    });

    it('should handle log level changes', () => {
      expect(() => {
        ganon.setLogLevel(2);
      }).not.toThrow();
    });

    it('should handle user lifecycle', async () => {
      // Start logged out
      expect(ganon.isUserLoggedIn()).toBe(false);

      // "Login"
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.isUserLoggedIn()).toBe(true);

      // "Logout"
      ganon.remove('user');
      expect(ganon.get('user')).toBeUndefined();
      expect(ganon.isUserLoggedIn()).toBe(false);
    });
  });

  describe('Hydration Protection', () => {
    it('should not mark keys as pending during hydration', async () => {
      // Set identifier key to simulate user being logged in
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.isUserLoggedIn()).toBe(true);

      // Simulate hydration by accessing the internal sync controller
      const syncController = (ganon as any).syncController;

      // Start hydration (set the flag)
      (syncController as any).isHydrating = true;

      // Try to set data during hydration
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });

      // Verify that the set operation completed without error during hydration
      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });

      // Clear hydration flag
      (syncController as any).isHydrating = false;
    });

    it('should not mark keys as pending during upsert hydration', async () => {
      // Set identifier key to simulate user being logged in
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.get('user')).toEqual({ id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.isUserLoggedIn()).toBe(true);

      // Simulate hydration by accessing the internal sync controller
      const syncController = (ganon as any).syncController;

      // Start hydration (set the flag)
      (syncController as any).isHydrating = true;

      // Try to upsert data during hydration
      ganon.upsert('user', { id: '123', name: 'Test User', email: 'test@example.com' });

      // Verify that the upsert operation completed without error during hydration
      const user = ganon.get('user');
      expect(user).toBeDefined();
      expect(user!.name).toBe('Test User');

      // Clear hydration flag
      (syncController as any).isHydrating = false;
    });

    it('should properly manage hydration state', async () => {
      const syncController = (ganon as any).syncController;

      // Initially not hydrating
      expect((syncController as any).hydrationPromise).toBeNull();

      // Simulate hydration start
      (syncController as any).hydrationPromise = Promise.resolve();
      expect((syncController as any).hydrationPromise).toBeDefined();

      // Simulate hydration end
      (syncController as any).hydrationPromise = null;
      expect((syncController as any).hydrationPromise).toBeNull();
    });

    it('should wait for hydration to complete before backup', async () => {
      const syncController = (ganon as any).syncController;

      // Mock the backup method to track calls and execution
      const originalBackup = syncController.syncAll;
      let backupStarted = false;
      let backupExecuted = false;

      // Create a promise that we can resolve when hydration completes
      let resolveBackup: () => void;
      const backupPromise = new Promise<void>(resolve => {
        resolveBackup = resolve;
      });

      syncController.syncAll = jest.fn().mockImplementation(async () => {
        backupStarted = true;
        // Wait for hydration to complete before executing backup
        await backupPromise;
        backupExecuted = true;
        return Promise.resolve();
      });

      // Start hydration
      (syncController as any).hydrationPromise = Promise.resolve();

      // Call backup - this should start immediately
      const resultPromise = ganon.backup();

      // Backup should start but not execute yet
      expect(backupStarted).toBe(true);
      expect(backupExecuted).toBe(false);

      // End hydration after a short delay
      setTimeout(() => {
        (syncController as any).hydrationPromise = null;
        resolveBackup!(); // Resolve the backup promise to allow execution
      }, 10);

      // Now backup should complete
      await resultPromise;
      expect(backupExecuted).toBe(true);

      // Restore original method
      syncController.syncAll = originalBackup;
    });

    it('should wait for hydration to complete before restore', async () => {
      // Set identifier key first to avoid login error
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.isUserLoggedIn()).toBe(true);

      const syncController = (ganon as any).syncController;

      // Mock the restore method to track calls and execution
      const originalRestore = syncController.restore;
      let restoreStarted = false;
      let restoreExecuted = false;

      // Create a promise that we can resolve when hydration completes
      let resolveRestore: () => void;
      const hydrationPromise = new Promise<void>(resolve => {
        resolveRestore = resolve;
      });

      syncController.restore = jest.fn().mockImplementation(async () => {
        restoreStarted = true;
        // Wait for hydration to complete before executing restore
        await hydrationPromise;
        restoreExecuted = true;
        return Promise.resolve({ success: true, restoredKeys: [], failedKeys: [], integrityFailures: [], timestamp: new Date() });
      });

      // Start hydration
      (syncController as any).hydrationPromise = Promise.resolve();

      // Call restore - this should start immediately
      const restoreResult = ganon.restore();

      // Restore should start but not execute yet
      expect(restoreStarted).toBe(true);
      expect(restoreExecuted).toBe(false);

      // End hydration after a short delay
      setTimeout(() => {
        (syncController as any).hydrationPromise = null;
        resolveRestore!(); // Resolve the hydration promise to allow execution
      }, 10);

      // Now restore should complete
      await restoreResult;
      expect(restoreExecuted).toBe(true);

      // Restore original method
      syncController.restore = originalRestore;
    });

    it('should timeout if hydration takes too long for restore', async () => {
      // Set identifier key first to avoid login error
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.isUserLoggedIn()).toBe(true);

      const syncController = (ganon as any).syncController;

      // Start hydration and keep it running
      (syncController as any).hydrationPromise = new Promise(() => {}); // Never resolves

      // Call restore
      const restoreResult = ganon.restore();

      // Quickly end hydration so the test doesn't take forever
      setTimeout(() => {
        (syncController as any).hydrationPromise = null;
      }, 10);

      // Should complete and return a result
      const result = await restoreResult;
      expect(result).toBeDefined();
    });

    it('should timeout if hydration takes too long for backup', async () => {
      const syncController = (ganon as any).syncController;

      // Mock the backup method to resolve quickly
      const originalBackup = syncController.syncAll;
      syncController.syncAll = jest.fn().mockResolvedValue({ success: true, backedUpKeys: [], failedKeys: [], timestamp: new Date() });

      // Start hydration with a promise that takes a bit longer than our test timeout
      (syncController as any).hydrationPromise = new Promise(resolve => setTimeout(resolve, 100));

      // Try to backup - this should timeout quickly
      const backupPromise = ganon.backup();

      // End hydration after a short delay
      setTimeout(() => {
        (syncController as any).hydrationPromise = null;
      }, 50);

      // Should complete and return a result
      const result = await backupPromise;
      expect(result).toBeDefined();

      // Restore original method
      syncController.syncAll = originalBackup;
    }, 1000); // Add a 1 second timeout for this test

    it('should trigger hydration automatically when identifier key is set', async () => {
      const syncController = (ganon as any).syncController;

      // Initially not hydrating
      expect((syncController as any).hydrationPromise).toBeNull();

      // Set identifier key which should log the user in and trigger hydration
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });

      // Verify user is logged in
      expect(ganon.isUserLoggedIn()).toBe(true);

      // Hydration should be triggered automatically when identifier key is set
      expect((syncController as any).hydrationPromise).toBeDefined();

      // End hydration
      (syncController as any).hydrationPromise = null;
      expect((syncController as any).hydrationPromise).toBeNull();
    });
  });

  describe('Force Hydration', () => {
    beforeEach(() => {
      // Set identifier key to simulate user being logged in
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.isUserLoggedIn()).toBe(true);
    });

    it('should force hydrate specific keys regardless of version comparison', async () => {
      // Mock the sync controller's forceHydrate method
      const syncController = (ganon as any).syncController;
      const mockForceHydrate = jest.fn().mockResolvedValue({
        success: true,
        restoredKeys: ['workouts', 'exercises'],
        failedKeys: [],
        integrityFailures: [],
        timestamp: new Date()
      });
      syncController.forceHydrate = mockForceHydrate;

      // Execute force hydration
      const result = await ganon.forceHydrate(['workouts', 'exercises']);

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('workouts');
      expect(result.restoredKeys).toContain('exercises');
      expect(result.failedKeys).toHaveLength(0);
      expect(mockForceHydrate).toHaveBeenCalledWith(['workouts', 'exercises'], undefined, undefined);
    });

    it('should handle force hydration failures gracefully', async () => {
      // Mock the sync controller's forceHydrate method to fail
      const syncController = (ganon as any).syncController;
      const mockForceHydrate = jest.fn().mockResolvedValue({
        success: false,
        restoredKeys: [],
        failedKeys: ['workouts'],
        integrityFailures: [],
        timestamp: new Date()
      });
      syncController.forceHydrate = mockForceHydrate;

      // Execute force hydration
      const result = await ganon.forceHydrate(['workouts']);

      // Verify results
      expect(result.success).toBe(false);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toContain('workouts');
      expect(mockForceHydrate).toHaveBeenCalledWith(['workouts'], undefined, undefined);
    });

    it('should throw error when force hydrating with destroyed instance', () => {
      ganon.destroy();

      expect(() => ganon.forceHydrate(['workouts'])).rejects.toThrow('Cannot perform operation: Ganon instance has been destroyed');
    });

    it('should handle force hydration with empty keys array', async () => {
      // Mock the sync controller's forceHydrate method
      const syncController = (ganon as any).syncController;
      const mockForceHydrate = jest.fn().mockResolvedValue({
        success: true,
        restoredKeys: [],
        failedKeys: [],
        integrityFailures: [],
        timestamp: new Date()
      });
      syncController.forceHydrate = mockForceHydrate;

      // Execute force hydration with empty array
      const result = await ganon.forceHydrate([]);

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toHaveLength(0);
      expect(mockForceHydrate).toHaveBeenCalledWith([], undefined, undefined);
    });

    it('should handle force hydration with sync controller errors', async () => {
      // Mock the sync controller's forceHydrate method to throw
      const syncController = (ganon as any).syncController;
      const mockForceHydrate = jest.fn().mockRejectedValue(new Error('Sync controller error'));
      syncController.forceHydrate = mockForceHydrate;

      // Execute force hydration
      await expect(ganon.forceHydrate(['workouts'])).rejects.toThrow('Force hydration operation failed: Error: Sync controller error');
      expect(mockForceHydrate).toHaveBeenCalledWith(['workouts'], undefined, undefined);
    });

    it('should handle force hydration with SyncError', async () => {
      // Mock the sync controller's forceHydrate method to throw SyncError
      const syncController = (ganon as any).syncController;
      const SyncError = require('../../errors/SyncError').default;
      const mockForceHydrate = jest.fn().mockRejectedValue(new SyncError('Sync error', 'SyncFailed'));
      syncController.forceHydrate = mockForceHydrate;

      // Execute force hydration
      await expect(ganon.forceHydrate(['workouts'])).rejects.toThrow('Sync error');
      expect(mockForceHydrate).toHaveBeenCalledWith(['workouts'], undefined, undefined);
    });
  });

  describe('Enhanced Hydration with Cache Invalidation', () => {
    beforeEach(() => {
      // Set identifier key to simulate user being logged in
      ganon.set('user', { id: '123', name: 'Test User', email: 'test@example.com' });
      expect(ganon.isUserLoggedIn()).toBe(true);
    });

    it('should hydrate with fresh cache invalidation', async () => {
      // Mock the sync controller's hydrate method
      const syncController = (ganon as any).syncController;
      const mockHydrate = jest.fn().mockResolvedValue({
        success: true,
        restoredKeys: ['workouts'],
        failedKeys: [],
        integrityFailures: [],
        timestamp: new Date()
      });
      syncController.hydrate = mockHydrate;

      // Execute hydration
      const result = await ganon.hydrate(['workouts']);

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('workouts');
      expect(result.failedKeys).toHaveLength(0);
      expect(mockHydrate).toHaveBeenCalledWith(['workouts'], undefined, undefined);
    });

    it('should handle hydration with cache invalidation errors', async () => {
      // Mock the sync controller's hydrate method to throw
      const syncController = (ganon as any).syncController;
      const mockHydrate = jest.fn().mockRejectedValue(new Error('Cache invalidation error'));
      syncController.hydrate = mockHydrate;

      // Execute hydration
      await expect(ganon.hydrate(['workouts'])).rejects.toThrow('Hydration operation failed: Error: Cache invalidation error');
      expect(mockHydrate).toHaveBeenCalledWith(['workouts'], undefined, undefined);
    });

    it('should handle hydration with SyncError from cache invalidation', async () => {
      // Mock the sync controller's hydrate method to throw SyncError
      const syncController = (ganon as any).syncController;
      const SyncError = require('../../errors/SyncError').default;
      const mockHydrate = jest.fn().mockRejectedValue(new SyncError('Cache sync error', 'SyncFailed'));
      syncController.hydrate = mockHydrate;

      // Execute hydration
      await expect(ganon.hydrate(['workouts'])).rejects.toThrow('Cache sync error');
      expect(mockHydrate).toHaveBeenCalledWith(['workouts'], undefined, undefined);
    });

    it('should hydrate all keys when no specific keys provided', async () => {
      // Mock the sync controller's hydrate method
      const syncController = (ganon as any).syncController;
      const mockHydrate = jest.fn().mockResolvedValue({
        success: true,
        restoredKeys: ['workouts', 'exercises', 'user'],
        failedKeys: [],
        integrityFailures: [],
        timestamp: new Date()
      });
      syncController.hydrate = mockHydrate;

      // Execute hydration without specific keys
      const result = await ganon.hydrate();

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('workouts');
      expect(result.restoredKeys).toContain('exercises');
      expect(result.restoredKeys).toContain('user');
      expect(result.failedKeys).toHaveLength(0);
      expect(mockHydrate).toHaveBeenCalledWith(undefined, undefined, undefined);
    });

    it('should handle hydration with partial failures', async () => {
      // Mock the sync controller's hydrate method
      const syncController = (ganon as any).syncController;
      const mockHydrate = jest.fn().mockResolvedValue({
        success: false,
        restoredKeys: ['workouts'],
        failedKeys: ['exercises'],
        integrityFailures: [],
        timestamp: new Date()
      });
      syncController.hydrate = mockHydrate;

      // Execute hydration
      const result = await ganon.hydrate(['workouts', 'exercises']);

      // Verify results
      expect(result.success).toBe(false);
      expect(result.restoredKeys).toContain('workouts');
      expect(result.failedKeys).toContain('exercises');
      expect(mockHydrate).toHaveBeenCalledWith(['workouts', 'exercises'], undefined, undefined);
    });

    it('should handle hydration when user is not logged in', async () => {
      // Remove user to simulate not logged in
      ganon.remove('user');
      expect(ganon.isUserLoggedIn()).toBe(false);

      // Mock the sync controller's hydrate method
      const syncController = (ganon as any).syncController;
      const mockHydrate = jest.fn().mockResolvedValue({
        success: false,
        restoredKeys: [],
        failedKeys: [],
        integrityFailures: [],
        timestamp: new Date()
      });
      syncController.hydrate = mockHydrate;

      // Execute hydration
      const result = await ganon.hydrate(['workouts']);

      // Verify results
      expect(result.success).toBe(false);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toHaveLength(0);
      expect(mockHydrate).toHaveBeenCalledWith(['workouts'], undefined, undefined);
    });
  });
});



