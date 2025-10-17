import { ConflictInfo, ConflictResolutionResult } from '../ConflictInfo';
import { ConflictResolutionStrategy } from '../../config/ConflictResolutionStrategy';
import { SyncStatus } from '../SyncStatus';

describe('ConflictInfo', () => {
  describe('interface validation', () => {
    it('should create a valid ConflictInfo object', () => {
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
        context: {
          operation: 'sync'
        }
      };

      expect(conflictInfo.key).toBe('test-key');
      expect(conflictInfo.localValue).toEqual({ name: 'John' });
      expect(conflictInfo.remoteValue).toEqual({ name: 'Jane' });
      expect(conflictInfo.resolutionStrategy).toBe(ConflictResolutionStrategy.LAST_MODIFIED_WINS);
      expect(conflictInfo.detectedAt).toBeGreaterThan(0);
      expect(conflictInfo.context?.operation).toBe('sync');
    });

    it('should handle optional fields', () => {
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
        resolutionStrategy: ConflictResolutionStrategy.LOCAL_WINS,
        detectedAt: Date.now(),
        // resolvedValue, resolvedAt, context are optional
      };

      expect(conflictInfo.resolvedValue).toBeUndefined();
      expect(conflictInfo.resolvedAt).toBeUndefined();
      expect(conflictInfo.context).toBeUndefined();
    });

    it('should handle field-level conflicts', () => {
      const conflictInfo: ConflictInfo<any> = {
        key: 'test-key',
        localValue: { name: 'John', age: 30 },
        remoteValue: { name: 'Jane', age: 25 },
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
        context: {
          operation: 'sync',
          fieldLevel: true,
          conflictingFields: ['name', 'age']
        }
      };

      expect(conflictInfo.context?.fieldLevel).toBe(true);
      expect(conflictInfo.context?.conflictingFields).toEqual(['name', 'age']);
    });
  });
});

describe('ConflictResolutionResult', () => {
  describe('interface validation', () => {
    it('should create a successful resolution result', () => {
      const result: ConflictResolutionResult = {
        success: true,
        strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
        resolvedValue: { name: 'Jane' }
      };

      expect(result.success).toBe(true);
      expect(result.strategy).toBe(ConflictResolutionStrategy.LAST_MODIFIED_WINS);
      expect(result.resolvedValue).toEqual({ name: 'Jane' });
      expect(result.error).toBeUndefined();
    });

    it('should create a failed resolution result', () => {
      const result: ConflictResolutionResult = {
        success: false,
        strategy: ConflictResolutionStrategy.LOCAL_WINS,
        resolvedValue: { name: 'John' },
        error: 'Unknown strategy'
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown strategy');
    });
  });
});
