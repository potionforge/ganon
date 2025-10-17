import { ConflictResolver } from '../../sync/ConflictResolver';
import { ConflictInfo } from '../../models/sync/ConflictInfo';
import { ConflictResolutionStrategy } from '../../models/config/ConflictResolutionStrategy';
import { ConflictMergeStrategy } from '../../models/config/ConflictMergeStrategy';
import { SyncStatus } from '../../models/sync/SyncStatus';

describe('ConflictResolver', () => {
  describe('detectConflict', () => {
    it('should return false when local value is undefined', () => {
      const result = ConflictResolver.detectConflict(
        'test-key',
        undefined,
        { name: 'John' },
        { version: 1, digest: 'hash1', syncStatus: SyncStatus.Synced },
        { version: 2, digest: 'hash2' }
      );
      
      expect(result).toBe(false);
    });

    it('should return false when remote value is undefined', () => {
      const result = ConflictResolver.detectConflict(
        'test-key',
        { name: 'John' },
        undefined,
        { version: 1, digest: 'hash1', syncStatus: SyncStatus.Synced },
        { version: 2, digest: 'hash2' }
      );
      
      expect(result).toBe(false);
    });

    it('should return false when values are identical', () => {
      const value = { name: 'John', age: 30 };
      const result = ConflictResolver.detectConflict(
        'test-key',
        value,
        value,
        { version: 1, digest: 'hash1', syncStatus: SyncStatus.Synced },
        { version: 2, digest: 'hash2' }
      );
      
      expect(result).toBe(false);
    });

    it('should return false when versions are the same', () => {
      const result = ConflictResolver.detectConflict(
        'test-key',
        { name: 'John' },
        { name: 'Jane' },
        { version: 1, digest: 'hash1', syncStatus: SyncStatus.Synced },
        { version: 1, digest: 'hash2' }
      );
      
      expect(result).toBe(false);
    });

    it('should return true when there is a data conflict', () => {
      const result = ConflictResolver.detectConflict(
        'test-key',
        { name: 'John' },
        { name: 'Jane' },
        { version: 1, digest: 'hash1', syncStatus: SyncStatus.Synced },
        { version: 2, digest: 'hash2' }
      );
      
      expect(result).toBe(true);
    });

    it('should handle primitive values correctly', () => {
      const result = ConflictResolver.detectConflict(
        'test-key',
        'John',
        'Jane',
        { version: 1, digest: 'hash1', syncStatus: SyncStatus.Synced },
        { version: 2, digest: 'hash2' }
      );
      
      expect(result).toBe(true);
    });

    it('should handle arrays correctly', () => {
      const result = ConflictResolver.detectConflict(
        'test-key',
        [1, 2, 3],
        [1, 2, 4],
        { version: 1, digest: 'hash1', syncStatus: SyncStatus.Synced },
        { version: 2, digest: 'hash2' }
      );
      
      expect(result).toBe(true);
    });
  });

  describe('resolveConflict', () => {
    const createConflictInfo = (localValue: unknown, remoteValue: unknown): ConflictInfo<any> => ({
      key: 'test-key',
      localValue,
      remoteValue,
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
    });

    describe('local-wins strategy', () => {
      it('should return local value', () => {
        const conflictInfo = createConflictInfo({ name: 'John' }, { name: 'Jane' });
        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LOCAL_WINS);
        
        expect(result.success).toBe(true);
        expect(result.strategy).toBe(ConflictResolutionStrategy.LOCAL_WINS);
        expect(result.resolvedValue).toEqual({ name: 'John' });
        expect(result.success).toBe(true);
      });
    });

    describe('remote-wins strategy', () => {
      it('should return remote value', () => {
        const conflictInfo = createConflictInfo({ name: 'John' }, { name: 'Jane' });
        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.REMOTE_WINS);
        
        expect(result.success).toBe(true);
        expect(result.strategy).toBe(ConflictResolutionStrategy.REMOTE_WINS);
        expect(result.resolvedValue).toEqual({ name: 'Jane' });
        expect(result.success).toBe(true);
      });
    });

    describe('last-modified-wins strategy', () => {
      it('should return remote value when remote is newer', () => {
        const conflictInfo = createConflictInfo({ name: 'John' }, { name: 'Jane' });
        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LAST_MODIFIED_WINS);
        
        expect(result.success).toBe(true);
        expect(result.strategy).toBe(ConflictResolutionStrategy.LAST_MODIFIED_WINS);
        expect(result.resolvedValue).toEqual({ name: 'Jane' });
      });

      it('should return local value when local is newer', () => {
        const conflictInfo: ConflictInfo<any> = {
          ...createConflictInfo({ name: 'John' }, { name: 'Jane' }),
          localMetadata: {
            version: 2,
            digest: 'hash2',
            syncStatus: SyncStatus.Synced
          },
          remoteMetadata: {
            version: 1,
            digest: 'hash1'
          }
        };
        
        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LAST_MODIFIED_WINS);
        
        expect(result.success).toBe(true);
        expect(result.strategy).toBe(ConflictResolutionStrategy.LAST_MODIFIED_WINS);
        expect(result.resolvedValue).toEqual({ name: 'John' });
      });
    });

    describe('error handling', () => {
      it('should handle unknown strategy', () => {
        const conflictInfo = createConflictInfo({ name: 'John' }, { name: 'Jane' });
        const result = ConflictResolver.resolveConflict(conflictInfo, 'unknown-strategy' as any);
        
        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown conflict resolution strategy');
      });
    });

    describe('merge strategies', () => {
      it('should perform shallow merge', () => {
        const localValue = { name: 'John', age: 30 };
        const remoteValue = { name: 'Jane', city: 'NYC' };
        const conflictInfo = createConflictInfo(localValue, remoteValue);
        
        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LOCAL_WINS, ConflictMergeStrategy.SHALLOW_MERGE);
        
        expect(result.success).toBe(true);
        expect(result.resolvedValue).toEqual({ name: 'John', age: 30, city: 'NYC' });
      });

      it('should perform deep merge', () => {
        const localValue = { 
          user: { name: 'John', age: 30 }, 
          settings: { theme: 'dark' } 
        };
        const remoteValue = { 
          user: { name: 'Jane', city: 'NYC' }, 
          settings: { language: 'en' } 
        };
        const conflictInfo = createConflictInfo(localValue, remoteValue);
        
        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LOCAL_WINS, ConflictMergeStrategy.DEEP_MERGE);
        
        expect(result.success).toBe(true);
        expect(result.resolvedValue).toEqual({
          user: { name: 'John', age: 30, city: 'NYC' },
          settings: { theme: 'dark', language: 'en' }
        });
      });

      it('should perform field-level merge', () => {
        const localValue = { name: 'John', age: 30 };
        const remoteValue = { name: 'Jane', age: 25 };
        const conflictInfo = createConflictInfo(localValue, remoteValue);
        
        const result = ConflictResolver.resolveConflict(conflictInfo, ConflictResolutionStrategy.LOCAL_WINS, ConflictMergeStrategy.FIELD_LEVEL);
        
        expect(result.success).toBe(true);
        expect(result.resolvedValue).toEqual({ name: 'John', age: 30 });
      });
    });
  });
});
