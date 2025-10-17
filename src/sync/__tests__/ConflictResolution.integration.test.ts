import { ConflictResolver } from '../ConflictResolver';
import { ConflictInfo } from '../../models/sync/ConflictInfo';
import { ConflictResolutionStrategy } from '../../models/config/ConflictResolutionStrategy';
import { ConflictMergeStrategy } from '../../models/config/ConflictMergeStrategy';
import { SyncStatus } from '../../models/sync/SyncStatus';

describe('Conflict Resolution Integration Tests', () => {
  describe('Real-world conflict scenarios', () => {
    it('should handle user profile conflicts', () => {
      const localProfile = {
        name: 'John Doe',
        email: 'john@example.com',
        preferences: {
          theme: 'dark',
          notifications: true
        },
        lastLogin: '2024-01-01T10:00:00Z'
      };

      const remoteProfile = {
        name: 'John Smith', // Changed name
        email: 'john@example.com',
        preferences: {
          theme: 'light', // Changed theme
          notifications: true,
          language: 'en' // Added language
        },
        lastLogin: '2024-01-02T15:30:00Z' // More recent login
      };

      const conflictInfo: ConflictInfo<any> = {
        key: 'user-profile',
        localValue: localProfile,
        remoteValue: remoteProfile,
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
        context: {
          operation: 'sync'
        }
      };

      // Test last-modified-wins strategy
      const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LAST_MODIFIED_WINS);
      
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toEqual(remoteProfile);
    });

    it('should handle deep merge for nested objects', () => {
      const localData = {
        user: {
          name: 'John',
          age: 30,
          address: {
            city: 'NYC',
            country: 'USA'
          }
        },
        settings: {
          theme: 'dark',
          notifications: true
        }
      };

      const remoteData = {
        user: {
          name: 'Jane', // Changed name
          age: 30,
          address: {
            city: 'NYC',
            country: 'USA',
            zipCode: '10001' // Added zipCode
          },
          phone: '+1234567890' // Added phone
        },
        settings: {
          theme: 'light', // Changed theme
          notifications: true,
          language: 'en' // Added language
        }
      };

      const conflictInfo: ConflictInfo<any> = {
        key: 'user-data',
        localValue: localData,
        remoteValue: remoteData,
        localMetadata: {
          version: 1,
          digest: 'hash1',
          syncStatus: SyncStatus.Synced
        },
        remoteMetadata: {
          version: 2,
          digest: 'hash2'
        },
        resolutionStrategy: ConflictResolutionStrategy.LOCAL_WINS,
        detectedAt: Date.now(),
      };

      const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LOCAL_WINS, ConflictMergeStrategy.DEEP_MERGE);
      
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toEqual({
        user: {
          name: 'John', // Local wins
          age: 30,
          address: {
            city: 'NYC',
            country: 'USA',
            zipCode: '10001' // Remote addition preserved
          },
          phone: '+1234567890' // Remote addition preserved
        },
        settings: {
          theme: 'dark', // Local wins
          notifications: true,
          language: 'en' // Remote addition preserved
        }
      });
    });

    it('should handle array conflicts', () => {
      const localData = {
        tags: ['work', 'important'],
        items: [
          { id: 1, name: 'Task 1', completed: false },
          { id: 2, name: 'Task 2', completed: true }
        ]
      };

      const remoteData = {
        tags: ['personal', 'urgent'], // Completely different
        items: [
          { id: 1, name: 'Task 1 Updated', completed: true }, // Modified
          { id: 3, name: 'Task 3', completed: false } // Different item
        ]
      };

      const conflictInfo: ConflictInfo<any> = {
        key: 'todo-list',
        localValue: localData,
        remoteValue: remoteData,
        localMetadata: {
          version: 1,
          digest: 'hash1',
          syncStatus: SyncStatus.Synced
        },
        remoteMetadata: {
          version: 2,
          digest: 'hash2'
        },
        resolutionStrategy: ConflictResolutionStrategy.REMOTE_WINS,
        detectedAt: Date.now(),
      };

      const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.REMOTE_WINS);
      
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toEqual(remoteData);
    });

    it('should handle primitive value conflicts', () => {
      const testCases = [
        { local: 'John', remote: 'Jane', expected: 'Jane' },
        { local: 42, remote: 24, expected: 24 },
        { local: true, remote: false, expected: false },
        { local: null, remote: 'value', expected: 'value' },
        { local: 'value', remote: null, expected: null }
      ];

      testCases.forEach(({ local, remote, expected }) => {
        const conflictInfo: ConflictInfo<any> = {
          key: 'primitive-test',
          localValue: local,
          remoteValue: remote,
          localMetadata: {
            version: 1,
            digest: 'hash1',
            syncStatus: SyncStatus.Synced
          },
          remoteMetadata: {
            version: 2,
            digest: 'hash2'
          },
          resolutionStrategy: ConflictResolutionStrategy.REMOTE_WINS,
          detectedAt: Date.now(),
        };

        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.REMOTE_WINS);
        
        expect(result.success).toBe(true);
        expect(result.resolvedValue).toBe(expected);
      });
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle circular references gracefully', () => {
      const localData: any = { name: 'John' };
      localData.self = localData; // Circular reference

      const remoteData = { name: 'Jane' };

      const conflictInfo: ConflictInfo<any> = {
        key: 'circular-test',
        localValue: localData,
        remoteValue: remoteData,
        localMetadata: {
          version: 1,
          digest: 'hash1',
          syncStatus: SyncStatus.Synced
        },
        remoteMetadata: {
          version: 2,
          digest: 'hash2'
        },
        resolutionStrategy: ConflictResolutionStrategy.REMOTE_WINS,
        detectedAt: Date.now(),
      };

      // This should not throw an error
      expect(() => {
        ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.REMOTE_WINS);
      }).not.toThrow();
    });

    it('should handle very large objects', () => {
      // Create a large object
      const largeObject: Record<string, any> = {};
      for (let i = 0; i < 1000; i++) {
        largeObject[`key${i}`] = {
          id: i,
          value: `value${i}`,
          nested: {
            data: `nested${i}`,
            array: Array.from({ length: 10 }, (_, j) => `item${i}-${j}`)
          }
        };
      }

      const localData = { ...largeObject, name: 'John' };
      const remoteData = { ...largeObject, name: 'Jane' };

      const conflictInfo: ConflictInfo<any> = {
        key: 'large-object-test',
        localValue: localData,
        remoteValue: remoteData,
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

      const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LAST_MODIFIED_WINS);
      
      expect(result.success).toBe(true);
      expect(result.resolvedValue).toEqual(remoteData);
    });

    it('should handle undefined and null values correctly', () => {
      const testCases = [
        { local: undefined, remote: { name: 'Jane' }, shouldConflict: false },
        { local: { name: 'John' }, remote: undefined, shouldConflict: false },
        { local: null, remote: { name: 'Jane' }, shouldConflict: false },
        { local: { name: 'John' }, remote: null, shouldConflict: false },
        { local: undefined, remote: undefined, shouldConflict: false },
        { local: null, remote: null, shouldConflict: false }
      ];

      testCases.forEach(({ local, remote, shouldConflict }) => {
        const hasConflict = ConflictResolver.detectConflict(
          'test-key',
          local,
          remote,
          { version: 1, digest: 'hash1', syncStatus: SyncStatus.Synced },
          { version: 2, digest: 'hash2' }
        );

        expect(hasConflict).toBe(shouldConflict);
      });
    });
  });

  describe('Performance tests', () => {
    it('should resolve conflicts efficiently', () => {
      const startTime = Date.now();
      
      // Create 100 conflicts
      for (let i = 0; i < 100; i++) {
        const conflictInfo: ConflictInfo<any> = {
          key: `test-key-${i}`,
          localValue: { id: i, name: `John${i}` },
          remoteValue: { id: i, name: `Jane${i}` },
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
          detectedAt: Date.now(),
        };

        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LAST_MODIFIED_WINS);
        expect(result.success).toBe(true);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should complete 100 conflicts in less than 1 second
      expect(duration).toBeLessThan(1000);
    });
  });
});
