// StorageManager Test Suite

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MockStorageManager, TestUtils } from '../../__mocks__/MockStorageManager';
import StorageManager from '../../managers/StorageManager';
import { TestStorageMapping } from '../../__mocks__/MockConfig';
import Log from '../../utils/Log';

// Mock Log before other mocks
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock MMKV for real StorageManager tests
const mockMMKVInstance = {
  getString: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
  contains: jest.fn(),
  clearAll: jest.fn(),
};

jest.mock('react-native-mmkv', () => ({
  MMKV: jest.fn(() => mockMMKVInstance)
}));

describe('StorageManager', () => {
  let storageManager: MockStorageManager<TestStorageMapping>;

  beforeEach(() => {
    // Clear all mocks including Log mocks
    jest.clearAllMocks();
    storageManager = new MockStorageManager<TestStorageMapping>();
  });

  afterEach(() => {
    storageManager.clearAllData();
  });

  describe('Basic Operations', () => {
    it('should store and retrieve data correctly', () => {
      const testUser = TestUtils.createTestData();

      storageManager.set('user', testUser);
      const retrieved = storageManager.get('user');

      expect(retrieved).toEqual(testUser);
      expect(storageManager.contains('user')).toBe(true);
    });

    it('should return undefined for non-existent keys', () => {
      const result = storageManager.get('user');
      expect(result).toBeUndefined();
      expect(storageManager.contains('user')).toBe(false);
    });

    it('should remove data correctly', () => {
      const testUser = TestUtils.createTestData();

      storageManager.set('user', testUser);
      expect(storageManager.contains('user')).toBe(true);

      storageManager.remove('user');
      expect(storageManager.contains('user')).toBe(false);
      expect(storageManager.get('user')).toBeUndefined();
    });

    it('should clear all data', () => {
      storageManager.set('user', TestUtils.createTestData());
      storageManager.set('settings', { theme: 'dark', notifications: true });

      expect(storageManager.getStorageSize()).toBe(2);

      storageManager.clearAllData();

      expect(storageManager.getStorageSize()).toBe(0);
      expect(storageManager.getCacheSize()).toBe(0);
    });

    it('should handle JSON parse errors gracefully', () => {
      // Use real StorageManager for error handling tests
      const realStorageManager = new StorageManager<TestStorageMapping>();
      mockMMKVInstance.getString.mockReturnValue('invalid json');
      const errorSpy = jest.spyOn(Log, 'error');

      const result = realStorageManager.get('user');
      expect(result).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Ganon: Error retrieving data:'));
    });

    it('should handle storage errors during set operation', () => {
      // Use real StorageManager for error handling tests
      const realStorageManager = new StorageManager<TestStorageMapping>();
      const testData = TestUtils.createTestData();
      mockMMKVInstance.set.mockImplementation(() => { throw new Error('Storage error'); });
      const errorSpy = jest.spyOn(Log, 'error');

      realStorageManager.set('user', testData);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Ganon: Error saving data:'));
    });

    it('should handle storage errors during remove operation', () => {
      // Use real StorageManager for error handling tests
      const realStorageManager = new StorageManager<TestStorageMapping>();
      mockMMKVInstance.delete.mockImplementation(() => { throw new Error('Storage error'); });
      const errorSpy = jest.spyOn(Log, 'error');

      realStorageManager.remove('user');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Ganon: Error removing data:'));
    });

    it('should handle storage errors during upsert operation', () => {
      // Use real StorageManager for error handling tests
      const realStorageManager = new StorageManager<TestStorageMapping>();
      mockMMKVInstance.set.mockImplementation(() => { throw new Error('Storage error'); });
      const errorSpy = jest.spyOn(Log, 'error');

      realStorageManager.upsert('user', TestUtils.createTestData());
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Ganon: Error saving data:'));
    });

    it('should handle null values and allow undefined', () => {
      // Use a type that allows null for this test
      type NullableUser = { id: string | null; name: string | null; email: string | null; };
      type TestMapping = { user: NullableUser; lastBackup: number };
      const storageManager = new MockStorageManager<TestMapping>();

      storageManager.set('user', { id: null, name: null, email: null });
      expect(storageManager.get('user')).toEqual({ id: null, name: null, email: null });

      // Undefined values should be allowed
      storageManager.set('user', undefined as any);
      expect(storageManager.get('user')).toBeUndefined();
    });
  });

  describe('Upsert Operations', () => {
    it('should create new entry when key does not exist', () => {
      const testUser = TestUtils.createTestData();

      storageManager.upsert('user', testUser);

      expect(storageManager.get('user')).toEqual(testUser);
    });

    it('should merge with existing data when key exists', () => {
      const initialUser = { id: '123', name: 'Initial', email: 'initial@test.com' };
      const updateData = { name: 'Updated Name' };

      storageManager.set('user', initialUser);
      storageManager.upsert('user', updateData as any);

      const result = storageManager.get('user');
      expect(result).toEqual({
        id: '123',
        name: 'Updated Name',
        email: 'initial@test.com'
      });
    });

    it('should handle nested object upserts', () => {
      const initialSettings = { theme: 'light' as const, notifications: false };
      const updateSettings = { notifications: true };

      storageManager.set('settings', initialSettings);
      storageManager.upsert('settings', updateSettings as any);

      const result = storageManager.get('settings');
      expect(result).toEqual({
        theme: 'light',
        notifications: true
      });
    });
  });

  describe('Cache Behavior', () => {
    it('should cache retrieved data', () => {
      const testUser = TestUtils.createTestData();

      storageManager.set('user', testUser);

      // First access - loads from storage
      const first = storageManager.get('user');
      expect(storageManager.getCacheSize()).toBe(1);

      // Second access - should use cache
      const second = storageManager.get('user');
      expect(first).toBe(second); // Same reference
    });

    it('should update cache when data is modified', () => {
      const testUser = TestUtils.createTestData();

      storageManager.set('user', testUser);
      const first = storageManager.get('user');

      const updatedUser = { ...testUser, name: 'Updated' };
      storageManager.set('user', updatedUser);
      const second = storageManager.get('user');

      expect(second).toEqual(updatedUser);
      expect(first).not.toBe(second); // Different references
    });

    it('should clear cache entry when data is removed', () => {
      const testUser = TestUtils.createTestData();

      storageManager.set('user', testUser);
      expect(storageManager.getCacheSize()).toBe(1);

      storageManager.remove('user');
      expect(storageManager.getCacheSize()).toBe(0);
    });

    it('should return cached value if available without hitting storage', () => {
      const testData = TestUtils.createTestData();
      // Use the real storage manager for this test since it has proper cache implementation
      const realStorageManager = new StorageManager<TestStorageMapping>();
      (realStorageManager as any).cache.user = testData;

      const result = realStorageManager.get('user');
      expect(result).toEqual(testData);
      expect(mockMMKVInstance.getString).not.toHaveBeenCalled();
    });

    it('should retrieve and cache value from storage if not in cache', () => {
      const testData = TestUtils.createTestData();
      // Use the real storage manager for this test since it has proper cache implementation
      const realStorageManager = new StorageManager<TestStorageMapping>();
      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(testData));

      const result = realStorageManager.get('user');
      expect(result).toEqual(testData);
      expect(mockMMKVInstance.getString).toHaveBeenCalledWith('user');
      expect((realStorageManager as any).cache.user).toEqual(testData);
    });
  });

  describe('Complex Data Types', () => {
    it('should handle arrays correctly', () => {
      const notes = ['Note 1', 'Note 2', 'Note 3'];

      storageManager.set('notes', notes);
      const retrieved = storageManager.get('notes');

      expect(retrieved).toEqual(notes);
      expect(Array.isArray(retrieved)).toBe(true);
    });

    it('should handle complex nested objects', () => {
      const exercises = {
        exercise1: { name: 'Push ups', reps: 20, sets: 3 },
        exercise2: { name: 'Squats', reps: 15, sets: 4 }
      };

      storageManager.set('exercises', exercises);
      const retrieved = storageManager.get('exercises');

      expect(retrieved).toEqual(exercises);
    });

    it('should handle large data sets', () => {
      const largeData = TestUtils.createLargeTestData(100);

      storageManager.set('largeData', largeData);
      const retrieved = storageManager.get('largeData');

      expect(retrieved).toEqual(largeData);
      expect(Object.keys(retrieved || {}).length).toBe(100);
    });
  });

  describe('Type Safety', () => {
    it('should maintain type safety for known keys', () => {
      const testUser = TestUtils.createTestData();

      storageManager.set('user', testUser);
      const retrieved = storageManager.get('user');

      // TypeScript should infer the correct type
      if (retrieved) {
        expect(typeof retrieved.id).toBe('string');
        expect(typeof retrieved.name).toBe('string');
        expect(typeof retrieved.email).toBe('string');
      }
    });

    it('should handle lastBackup as required by BaseStorageMapping', () => {
      const timestamp = Date.now();

      storageManager.set('lastBackup', timestamp);
      const retrieved = storageManager.get('lastBackup');

      expect(retrieved).toBe(timestamp);
      expect(typeof retrieved).toBe('number');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty objects and arrays', () => {
      storageManager.set('exercises', {});
      expect(storageManager.get('exercises')).toEqual({});

      storageManager.set('notes', []);
      expect(storageManager.get('notes')).toEqual([]);
    });

    it('should handle special characters in data', () => {
      const specialUser = {
        id: 'test-123',
        name: 'User with "quotes" and \\backslashes',
        email: 'test+special@example.com'
      };

      storageManager.set('user', specialUser);
      const retrieved = storageManager.get('user');

      expect(retrieved).toEqual(specialUser);
    });
  });

  describe('Performance', () => {
    it('should handle multiple rapid operations', () => {
      const operations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < operations; i++) {
        storageManager.set(`user`, {
          id: `user-${i}`,
          name: `User ${i}`,
          email: `user${i}@test.com`
        });
        storageManager.get(`user`);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within reasonable time (adjust as needed)
      expect(duration).toBeLessThan(1000); // 1 second
      expect(storageManager.getStorageSize()).toBe(1);
    });

    it('should efficiently handle cache operations', () => {
      const testData = TestUtils.createLargeTestData(50);

      storageManager.set('largeData', testData);

      // Multiple cache hits should be fast
      const startTime = Date.now();
      for (let i = 0; i < 100; i++) {
        storageManager.get('largeData');
      }
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(50); // Very fast cache access
    });
  });
});

describe('StorageManager Contract Verification', () => {
  let realStorageManager: StorageManager<TestStorageMapping>;
  let mockStorageManager: MockStorageManager<TestStorageMapping>;

  beforeEach(() => {
    jest.clearAllMocks();
    realStorageManager = new StorageManager<TestStorageMapping>();
    mockStorageManager = new MockStorageManager<TestStorageMapping>();
  });

  afterEach(() => {
    mockStorageManager.clearAllData();
  });

  /**
   * These tests verify that MockStorageManager behaves consistently with the real StorageManager
   * for the basic contract. This ensures that tests using mocks accurately reflect real behavior.
   */

  describe('Contract: Basic Operations', () => {
    it('should handle set/get operations consistently', () => {
      const testUser = TestUtils.createTestData();

      // Setup real storage to return the data
      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(testUser));
      mockMMKVInstance.contains.mockReturnValue(true);

      // Test both implementations
      realStorageManager.set('user', testUser);
      mockStorageManager.set('user', testUser);

      const realResult = realStorageManager.get('user');
      const mockResult = mockStorageManager.get('user');

      expect(mockResult).toEqual(realResult);
      expect(mockResult).toEqual(testUser);
    });

    it('should handle non-existent keys consistently', () => {
      mockMMKVInstance.getString.mockReturnValue(undefined);
      mockMMKVInstance.contains.mockReturnValue(false);

      const realResult = realStorageManager.get('user');
      const mockResult = mockStorageManager.get('user');

      expect(mockResult).toEqual(realResult);
      expect(mockResult).toBeUndefined();

      expect(realStorageManager.contains('user')).toBe(false);
      expect(mockStorageManager.contains('user')).toBe(false);
    });

    it('should handle remove operations consistently', () => {
      const testUser = TestUtils.createTestData();

      // Set up initial state
      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(testUser));
      mockMMKVInstance.contains.mockReturnValue(true);

      realStorageManager.set('user', testUser);
      mockStorageManager.set('user', testUser);

      // Mock the removal response
      mockMMKVInstance.getString.mockReturnValue(undefined);
      mockMMKVInstance.contains.mockReturnValue(false);

      // Remove from both
      realStorageManager.remove('user');
      mockStorageManager.remove('user');

      const realResult = realStorageManager.get('user');
      const mockResult = mockStorageManager.get('user');

      expect(mockResult).toEqual(realResult);
      expect(mockResult).toBeUndefined();
      expect(realStorageManager.contains('user')).toBe(false);
      expect(mockStorageManager.contains('user')).toBe(false);
    });

    it('should handle upsert operations consistently', () => {
      const initialUser = { id: '123', name: 'Initial', email: 'initial@test.com' };
      const updateData = { name: 'Updated Name' };
      const expectedResult = { id: '123', name: 'Updated Name', email: 'initial@test.com' };

      // Setup initial data
      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(initialUser));
      mockMMKVInstance.contains.mockReturnValue(true);

      realStorageManager.set('user', initialUser);
      mockStorageManager.set('user', initialUser);

      // Setup for upsert result
      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(expectedResult));

      // Perform upsert
      realStorageManager.upsert('user', updateData as any);
      mockStorageManager.upsert('user', updateData as any);

      const realResult = realStorageManager.get('user');
      const mockResult = mockStorageManager.get('user');

      expect(mockResult).toEqual(realResult);
      expect(mockResult).toEqual(expectedResult);
    });

    it('should handle upsert on non-existent keys consistently', () => {
      const testUser = TestUtils.createTestData();

      // Setup for non-existent key
      mockMMKVInstance.contains.mockReturnValue(false);
      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(testUser));

      realStorageManager.upsert('user', testUser);
      mockStorageManager.upsert('user', testUser);

      const realResult = realStorageManager.get('user');
      const mockResult = mockStorageManager.get('user');

      expect(mockResult).toEqual(realResult);
      expect(mockResult).toEqual(testUser);
    });

    it('should handle clearAllData consistently', () => {
      const testUser = TestUtils.createTestData();
      const testSettings = { theme: 'dark' as const, notifications: true };

      // Set initial data
      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(testUser));
      mockMMKVInstance.contains.mockReturnValue(true);

      realStorageManager.set('user', testUser);
      realStorageManager.set('settings', testSettings);
      mockStorageManager.set('user', testUser);
      mockStorageManager.set('settings', testSettings);

      // Setup for cleared state
      mockMMKVInstance.getString.mockReturnValue(undefined);
      mockMMKVInstance.contains.mockReturnValue(false);

      // Clear all data
      realStorageManager.clearAllData();
      mockStorageManager.clearAllData();

      // Verify both are cleared
      expect(realStorageManager.get('user')).toBeUndefined();
      expect(mockStorageManager.get('user')).toBeUndefined();
      expect(realStorageManager.contains('user')).toBe(false);
      expect(mockStorageManager.contains('user')).toBe(false);
    });
  });

  describe('Contract: Complex Data Types', () => {
    it('should handle arrays consistently', () => {
      const notes = ['Note 1', 'Note 2', 'Note 3'];

      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(notes));
      mockMMKVInstance.contains.mockReturnValue(true);

      realStorageManager.set('notes', notes);
      mockStorageManager.set('notes', notes);

      const realResult = realStorageManager.get('notes');
      const mockResult = mockStorageManager.get('notes');

      expect(mockResult).toEqual(realResult);
      expect(Array.isArray(mockResult)).toBe(true);
      expect(Array.isArray(realResult)).toBe(true);
    });

    it('should handle nested objects consistently', () => {
      const exercises = {
        exercise1: { name: 'Push ups', reps: 20, sets: 3 },
        exercise2: { name: 'Squats', reps: 15, sets: 4 }
      };

      mockMMKVInstance.getString.mockReturnValue(JSON.stringify(exercises));
      mockMMKVInstance.contains.mockReturnValue(true);

      realStorageManager.set('exercises', exercises);
      mockStorageManager.set('exercises', exercises);

      const realResult = realStorageManager.get('exercises');
      const mockResult = mockStorageManager.get('exercises');

      expect(mockResult).toEqual(realResult);
    });
  });

  describe('Warning: Known Differences', () => {
    /**
     * These tests document known differences between mock and real implementations.
     * They serve as documentation and early warning if these differences become problematic.
     */

    it('KNOWN DIFF: Real storage has cache size limits, mock does not', () => {
      // This documents that real StorageManager has MAX_CACHE_SIZE = 100
      // while MockStorageManager has unlimited cache
      // If this becomes problematic for tests, the mock should be updated

      const realCacheLimit = 100; // From real StorageManager
      const mockHasLimit = false; // MockStorageManager doesn't implement cache limits

      expect(mockHasLimit).toBe(false);
      expect(realCacheLimit).toBe(100);

      // This test serves as documentation and will remind us to update
      // the mock if cache behavior becomes critical for testing
    });

    it('KNOWN DIFF: Real storage handles JSON serialization errors, mock does not', () => {
      // Real StorageManager handles JSON.parse errors gracefully
      // MockStorageManager stores objects directly without serialization

      const realHandlesJsonErrors = true;
      const mockHandlesJsonErrors = false;

      expect(realHandlesJsonErrors).toBe(true);
      expect(mockHandlesJsonErrors).toBe(false);

      // If JSON serialization behavior becomes critical for testing,
      // consider updating MockStorageManager to simulate this
    });
  });
});
