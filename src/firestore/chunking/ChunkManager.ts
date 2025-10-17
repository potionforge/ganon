import FirestoreAdapter from "../FirestoreAdapter";
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import Log from "../../utils/Log";
import DataProcessor from "../processing/DataProcessor";
import SyncError, { SyncErrorType } from "../../errors/SyncError";
import { calculateDataSize } from './helpers/sizeUtils';
import { areChunksEqual } from './helpers/chunkComparison';
import { checkIfNeedsChunking } from './helpers/chunkValidation';
import { reconstructChunkedData } from './helpers/chunkReconstruction';
import { generateChunks } from './helpers/chunkGeneration';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
export interface ChunkedData {
  chunks: Array<[string, any]>;
  isChunked: boolean;
}

export default class ChunkManager<T extends BaseStorageMapping> {
  private readonly MAX_CHUNK_SIZE = 200_000; // 200KB max per chunk
  private readonly dataProcessor: DataProcessor;
  private readonly CACHE_TTL = 5000; // 5 seconds cache TTL
  private readonly BATCH_SIZE = 10; // Process 10 chunks at a time
  private readonly BATCH_DELAY = 50; // 50ms delay between batches
  private readonly LOCK_TIMEOUT = 30000; // 30 second lock timeout

  // Enhanced cache with write tracking
  private collectionCache = new Map<string, {
    timestamp: number;
    snapshot: FirebaseFirestoreTypes.QuerySnapshot;
    version: number; // Add version for optimistic locking
  }>();

  // Track active writes to prevent cache hits during writes
  private activeWrites = new Set<string>();

  // Track write locks to prevent concurrent writes
  private writeLocks = new Map<string, {
    promise: Promise<void>;
    timestamp: number;
  }>();

  // Track cache versions for optimistic locking
  private cacheVersions = new Map<string, number>();

  constructor(
    private adapter: FirestoreAdapter<T>,
    dataProcessor?: DataProcessor
  ) {
    this.dataProcessor = dataProcessor || new DataProcessor();
  }

  /**
   * Acquire a write lock with timeout
   */
  private async acquireWriteLock(collectionPath: string): Promise<() => void> {
    const now = Date.now();
    const existingLock = this.writeLocks.get(collectionPath);

    if (existingLock) {
      // Check for stale lock
      if (now - existingLock.timestamp > this.LOCK_TIMEOUT) {
        Log.warn(`ChunkManager: Clearing stale write lock on ${collectionPath}`);
        this.writeLocks.delete(collectionPath);
        this.activeWrites.delete(collectionPath);
      } else {
        Log.info(`ChunkManager: Waiting for existing write lock on ${collectionPath}`);
        await existingLock.promise;
      }
    }

    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.writeLocks.set(collectionPath, { promise: lockPromise, timestamp: now });
    this.activeWrites.add(collectionPath);

    // Increment cache version for optimistic locking
    const currentVersion = (this.cacheVersions.get(collectionPath) || 0) + 1;
    this.cacheVersions.set(collectionPath, currentVersion);

    return () => {
      this.writeLocks.delete(collectionPath);
      this.activeWrites.delete(collectionPath);
      releaseLock!();
      Log.verbose(`ChunkManager: Released write lock on ${collectionPath}`);
    };
  }

  /**
   * Get collection with enhanced caching and write awareness
   */
  private async getCachedCollection(
    collectionRef: FirebaseFirestoreTypes.CollectionReference,
    options: {
      allowCacheForWrites?: boolean;
      requireFresh?: boolean;
    } = {}
  ): Promise<FirebaseFirestoreTypes.QuerySnapshot> {
    const cacheKey = collectionRef.path;
    const now = Date.now();

    // Force fresh data if required
    if (options.requireFresh) {
      Log.info(`ChunkManager: Forcing fresh data for ${cacheKey}`);
      const snapshot = await this.adapter.getCollection(collectionRef);
      this.updateCache(cacheKey, snapshot, now);
      return snapshot;
    }

    // Don't use cache if there's an active write (unless explicitly allowed)
    if (!options.allowCacheForWrites && this.activeWrites.has(cacheKey)) {
      Log.info(`ChunkManager: Bypassing cache due to active write on ${cacheKey}`);
      const snapshot = await this.adapter.getCollection(collectionRef);
      return snapshot;
    }

    const cached = this.collectionCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      // Verify cache version hasn't changed
      const currentVersion = this.cacheVersions.get(cacheKey) || 0;
      if (cached.version === currentVersion) {
        Log.verbose(`ChunkManager: Using cached collection for ${cacheKey}`);
        return cached.snapshot;
      }
      Log.info(`ChunkManager: Cache version mismatch for ${cacheKey}, fetching fresh data`);
    }

    const snapshot = await this.adapter.getCollection(collectionRef);
    this.updateCache(cacheKey, snapshot, now);
    return snapshot;
  }

  /**
   * Update cache with version tracking
   */
  private updateCache(
    cacheKey: string,
    snapshot: FirebaseFirestoreTypes.QuerySnapshot,
    timestamp: number
  ): void {
    const version = this.cacheVersions.get(cacheKey) || 0;
    this.collectionCache.set(cacheKey, { timestamp, snapshot, version });
  }

  /**
   * Clear cache with version increment
   */
  private clearCollectionCache(collectionRef: FirebaseFirestoreTypes.CollectionReference): void {
    const cacheKey = collectionRef.path;
    this.collectionCache.delete(cacheKey);
    // Don't increment version here - that's handled by acquireWriteLock
    Log.verbose(`ChunkManager: Cleared cache for ${cacheKey}`);
  }

  /**
   * Recursively checks if any fields were deleted in nested objects
   * @private
   */
  private hasDeletedFieldsRecursive(existing: any, current: any): boolean {
    // If either is not an object, compare directly
    if (typeof existing !== 'object' || typeof current !== 'object' || existing === null || current === null) {
      return false;
    }

    // Check all keys in existing object
    for (const key in existing) {
      // If key doesn't exist in current object, it was deleted
      if (!(key in current)) {
        return true;
      }

      // If both values are objects, check recursively
      if (typeof existing[key] === 'object' && existing[key] !== null &&
          typeof current[key] === 'object' && current[key] !== null) {
        if (this.hasDeletedFieldsRecursive(existing[key], current[key])) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Writes data to Firestore with transaction support
   * @param collectionRef - The collection reference to write to
   * @param key - The key to write the value for
   * @param value - The value to write
   * @param options - Optional parameters for the write operation
   * @returns Promise that resolves when the write is complete
   */
  async writeData(
    collectionRef: FirebaseFirestoreTypes.CollectionReference,
    key: string,
    value: any,
    options?: { transaction?: FirebaseFirestoreTypes.Transaction }
  ): Promise<void> {
    const operationStartTime = Date.now();
    Log.info(`ChunkManager: Starting write operation for key "${key}"`);

    const releaseLock = await this.acquireWriteLock(collectionRef.path);

    try {
      // Clear cache immediately when starting write
      this.clearCollectionCache(collectionRef);

      // Sanitize data for Firestore using DataProcessor
      const sanitizeStartTime = Date.now();
      const sanitizedValue = this.dataProcessor.sanitizeForFirestore(value);
      const sanitizeDuration = Date.now() - sanitizeStartTime;
      Log.verbose(`ChunkManager: Data sanitization took ${sanitizeDuration}ms for key "${key}"`);

      // CRITICAL: Check field count before size calculation
      const validationStartTime = Date.now();
      const needsChunking = this.checkIfNeedsChunking(sanitizedValue);
      const validationDuration = Date.now() - validationStartTime;
      Log.verbose(`ChunkManager: Validation took ${validationDuration}ms for key "${key}"`);

      if (needsChunking.forceChunk) {
        Log.info(`ChunkManager: Forcing chunking for key "${key}" due to: ${needsChunking.reason}`);
      }

      // Calculate approximate size
      const sizeCalcStartTime = Date.now();
      const dataSize = this.calculateDataSize(sanitizedValue);
      const sizeCalcDuration = Date.now() - sizeCalcStartTime;
      Log.verbose(`ChunkManager: Size calculation took ${sizeCalcDuration}ms for key "${key}" (size: ${dataSize} bytes)`);

      const isPrimitive = typeof value !== 'object' || value === null;

      // Handle primitive values that are too large
      if (dataSize > this.MAX_CHUNK_SIZE && isPrimitive) {
        throw new SyncError(
          `Data for key "${key}" is a primitive value and is too large to backup. Size: ${dataSize}`,
          SyncErrorType.SyncValidationError
        );
      }

      // Additional safety check for extremely large data
      if (dataSize > 5000000) { // 5MB limit to prevent native memory issues
        throw new SyncError(
          `Data for key "${key}" is too large and may cause stability issues. Size: ${dataSize} bytes`,
          SyncErrorType.SyncValidationError
        );
      }

      // Validate data before proceeding
      const firestoreValidationStartTime = Date.now();
      const validation = this.dataProcessor.validateForFirestore(sanitizedValue);
      const firestoreValidationDuration = Date.now() - firestoreValidationStartTime;
      Log.verbose(`ChunkManager: Firestore validation took ${firestoreValidationDuration}ms for key "${key}"`);

      if (!validation.isValid) {
        throw new SyncError(
          `Data validation failed for key "${key}": ${validation.errors.join(', ')}`,
          SyncErrorType.SyncValidationError
        );
      }

      // Use hybrid approach based on data size and chunking needs
      const writeStartTime = Date.now();
      if (dataSize <= this.MAX_CHUNK_SIZE && !needsChunking.forceChunk) {
        Log.info(`ChunkManager: Using single document approach for key "${key}"`);
        await this.writeSingleDocumentWithMerge(collectionRef, sanitizedValue, key, options);
      } else {
        Log.info(`ChunkManager: Using chunked approach for key "${key}"`);
        await this.writeChunkedDataWithDiff(collectionRef, sanitizedValue, key, options);
      }
      const writeDuration = Date.now() - writeStartTime;
      const totalDuration = Date.now() - operationStartTime;

      Log.info(`ChunkManager: Write operation completed for key "${key}" in ${totalDuration}ms (actual write: ${writeDuration}ms)`);

    } catch (error) {
      const totalDuration = Date.now() - operationStartTime;
      Log.error(`ChunkManager: Write operation failed for key "${key}" after ${totalDuration}ms: ${error}`);

      // Debug the problematic write operation
      try {
        await this.debugWriteOperation(key, value);
      } catch (debugError) {
        Log.error(`ChunkManager: debugWriteOperation failed for key "${key}": ${debugError}`);
      }

      const errorString = String(error);
      const isNativeCorruption = errorString.includes('malloc') ||
                              errorString.includes('corruption') ||
                              errorString.includes('pb_decode') ||
                              errorString.includes('protobuf');

      if (isNativeCorruption) {
        Log.error(`ChunkManager: Native layer corruption detected during write for key "${key}"`);
        throw new SyncError(
          `Native layer corruption during write operation for key "${key}": ${error}`,
          SyncErrorType.SyncFailed
        );
      }

      if (error instanceof SyncError) {
        throw error;
      }

      throw new SyncError(
        `Failed to write data for key "${key}": ${error}`,
        SyncErrorType.SyncFailed
      );
    } finally {
      // Always release lock and clear cache
      this.clearCollectionCache(collectionRef);
      releaseLock();
    }
  }

  /**
   * Writes a single document using merge for efficiency
   */
  private async writeSingleDocumentWithMerge(
    collectionRef: FirebaseFirestoreTypes.CollectionReference,
    value: any,
    key: string,
    options?: { transaction?: FirebaseFirestoreTypes.Transaction }
  ): Promise<void> {
    const startTime = Date.now();
    Log.info(`ChunkManager: Starting single document merge for key "${key}"`);

    // Use cached collection read
    const readStartTime = Date.now();
    const existingSnapshot = await this.getCachedCollection(collectionRef);
    const readDuration = Date.now() - readStartTime;
    Log.verbose(`ChunkManager: Collection read took ${readDuration}ms for key "${key}"`);

    const chunkDocs = existingSnapshot.docs.filter(doc => doc.id.startsWith('chunk_'));

    // Prepare the data to write
    let toWrite = value;
    if (Array.isArray(value)) {
      toWrite = Object.fromEntries(value.map((v, i) => [String(i), v]));
    }

    const writeStartTime = Date.now();
    if (chunkDocs.length > 1) {
      // Multiple chunks exist, need to clean up others and replace chunk_0 entirely
      if (options?.transaction) {
        // Delete all chunks except chunk_0
        chunkDocs.slice(1).forEach(doc => {
          Log.info(`ChunkManager: Deleting extra chunk ${doc.id} for key "${key}"`);
          this.adapter.deleteDocumentWithTransaction(options.transaction!, doc.ref);
        });

        // Replace chunk_0 entirely (not merge) to avoid leftover fields
        const chunk0Ref = collectionRef.doc('chunk_0');
        Log.info(`ChunkManager: Replacing chunk_0 with ${Object.keys(toWrite).length} fields for key "${key}"`);
        this.adapter.setDocumentWithTransaction(options.transaction, chunk0Ref, toWrite); // Use set, not merge, to replace entirely
      } else {
        const batch = this.adapter.writeBatch();

        // Delete all chunks except chunk_0
        chunkDocs.slice(1).forEach(doc => {
          Log.info(`ChunkManager: Deleting extra chunk ${doc.id} for key "${key}"`);
          batch.delete(doc.ref);
        });

        // Replace chunk_0 entirely (not merge) to avoid leftover fields
        const chunk0Ref = collectionRef.doc('chunk_0');
        Log.info(`ChunkManager: Replacing chunk_0 with ${Object.keys(toWrite).length} fields for key "${key}"`);
        batch.set(chunk0Ref, toWrite); // Use set, not merge, to replace entirely

        await batch.commit();
      }
      Log.info(`ChunkManager: Cleaned up ${chunkDocs.length - 1} extra chunks and replaced chunk_0 for key "${key}"`);
    } else if (chunkDocs.length === 1) {
      // Only chunk_0 exists - decide between merge or replace based on data type and field changes
      const docRef = collectionRef.doc('chunk_0');
      const existingData = chunkDocs[0].data();

      // Check for deleted fields recursively
      const hasDeletedFields = this.hasDeletedFieldsRecursive(existingData, toWrite);

      // For arrays converted to objects, we should replace to avoid orphaned keys
      // For regular objects, we use merge only if no fields were deleted
      if (Array.isArray(value) || hasDeletedFields) {
        const operation = Array.isArray(value) ? 'array data' : 'deleted fields';
        Log.info(`ChunkManager: Replacing chunk_0 for ${operation} (${Object.keys(toWrite).length} items) for key "${key}"`);
        if (options?.transaction) {
          await this.adapter.setDocumentWithTransaction(options.transaction, docRef, toWrite); // Replace to avoid orphaned fields
        } else {
          await this.adapter.setDocument(docRef, toWrite); // Replace to avoid orphaned fields
        }
      } else {
        Log.info(`ChunkManager: Merging ${Object.keys(toWrite).length} fields into existing chunk_0 for key "${key}"`);
        if (options?.transaction) {
          await this.adapter.setDocumentWithTransaction(options.transaction, docRef, toWrite, { merge: true });
        } else {
          await this.adapter.setDocument(docRef, toWrite, { merge: true });
        }
      }
    } else {
      // No chunks exist, create chunk_0
      const docRef = collectionRef.doc('chunk_0');
      Log.info(`ChunkManager: Creating new chunk_0 with ${Object.keys(toWrite).length} fields for key "${key}"`);
      if (options?.transaction) {
        await this.adapter.setDocumentWithTransaction(options.transaction, docRef, toWrite);
      } else {
        await this.adapter.setDocument(docRef, toWrite);
      }
    }
    const writeDuration = Date.now() - writeStartTime;
    const totalDuration = Date.now() - startTime;

    Log.info(`ChunkManager: Single document operation completed for key "${key}" in ${totalDuration}ms (write: ${writeDuration}ms)`);

    // Clear cache after write
    this.clearCollectionCache(collectionRef);
  }

  /**
   * Writes chunked data using smart diffing for efficiency
   */
  private async writeChunkedDataWithDiff(
    collectionRef: FirebaseFirestoreTypes.CollectionReference,
    value: any,
    key: string,
    options?: { transaction?: FirebaseFirestoreTypes.Transaction }
  ): Promise<void> {
    const startTime = Date.now();
    Log.info(`ChunkManager: Starting chunked diff operation for key "${key}"`);

    const metrics = {
      updatedChunks: 0,
      skippedChunks: 0,
      deletedChunks: 0,
      totalFields: 0,
      totalChunks: 0,
      readDuration: 0,
      chunkGenDuration: 0,
      writeDuration: 0,
      deleteDuration: 0
    };

    try {
      if (typeof value !== 'object' || value === null) {
        throw new Error('Value must be an object for chunking');
      }

      // Use cached collection read
      const readStartTime = Date.now();
      const existingSnapshot = await this.getCachedCollection(collectionRef);
      metrics.readDuration = Date.now() - readStartTime;
      Log.verbose(`ChunkManager: Collection read took ${metrics.readDuration}ms for key "${key}"`);

      const existingChunks = new Map<string, any>();

      existingSnapshot.docs
        .filter(doc => doc.id.startsWith('chunk_'))
        .forEach(doc => {
          existingChunks.set(doc.id, doc.data());
        });

      // Generate new chunks with progress logging
      Log.info(`ChunkManager: Generating chunks for ${Object.keys(value).length} fields for key "${key}"...`);
      const chunkGenStartTime = Date.now();
      const newChunks = await generateChunks(value);
      metrics.chunkGenDuration = Date.now() - chunkGenStartTime;
      metrics.totalChunks = newChunks.length;
      Log.verbose(`ChunkManager: Chunk generation took ${metrics.chunkGenDuration}ms for key "${key}" (${metrics.totalChunks} chunks)`);

      // Process chunks in batches
      const writeStartTime = Date.now();
      if (options?.transaction) {
        const transaction = options.transaction; // Store transaction in a variable to satisfy TypeScript
        // Process all chunks in a single transaction
        for (let i = 0; i < newChunks.length; i++) {
          const chunkData = newChunks[i];
          const chunkId = `chunk_${i}`;
          const existingData = existingChunks.get(chunkId);
          const fieldCount = Object.keys(chunkData).length;
          metrics.totalFields += fieldCount;

          // Only write if chunk is new or different
          if (!existingData || !this.areChunksEqual(existingData, chunkData)) {
            const docRef = collectionRef.doc(chunkId);
            Log.info(`ChunkManager: Updating chunk ${chunkId} (${fieldCount} fields) for key "${key}"`);
            await this.adapter.setDocumentWithTransaction(transaction, docRef, chunkData);
            metrics.updatedChunks++;
          } else {
            Log.info(`ChunkManager: Skipping unchanged chunk ${chunkId} for key "${key}"`);
            metrics.skippedChunks++;
          }

          existingChunks.delete(chunkId); // Mark as processed

          // Log progress for large operations
          if (i % 5 === 0) {
            Log.info(`ChunkManager: Processing chunk ${i + 1}/${newChunks.length} for key "${key}"`);
          }
        }

        // Delete obsolete chunks
        if (existingChunks.size > 0) {
          existingChunks.forEach((_, chunkId) => {
            const docRef = collectionRef.doc(chunkId);
            Log.info(`ChunkManager: Deleting obsolete chunk ${chunkId} for key "${key}"`);
            this.adapter.deleteDocumentWithTransaction(transaction, docRef);
            metrics.deletedChunks++;
          });
        }
      } else {
        // Process chunks in batches without transaction
        for (let i = 0; i < newChunks.length; i += this.BATCH_SIZE) {
          const chunkBatch = newChunks.slice(i, i + this.BATCH_SIZE);
          const batch = this.adapter.writeBatch();
          let batchHasChanges = false;

          for (const [index, chunkData] of chunkBatch.entries()) {
            const chunkIndex = i + index;
            const chunkId = `chunk_${chunkIndex}`;
            const existingData = existingChunks.get(chunkId);
            const fieldCount = Object.keys(chunkData).length;
            metrics.totalFields += fieldCount;

            // Only write if chunk is new or different
            if (!existingData || !this.areChunksEqual(existingData, chunkData)) {
              const docRef = collectionRef.doc(chunkId);
              Log.info(`ChunkManager: Updating chunk ${chunkId} (${fieldCount} fields) for key "${key}"`);
              batch.set(docRef, chunkData);
              metrics.updatedChunks++;
              batchHasChanges = true;
            } else {
              Log.info(`ChunkManager: Skipping unchanged chunk ${chunkId} for key "${key}"`);
              metrics.skippedChunks++;
            }

            existingChunks.delete(chunkId); // Mark as processed

            // Log progress for large operations
            if (chunkIndex % 5 === 0) {
              Log.info(`ChunkManager: Processing chunk ${chunkIndex + 1}/${newChunks.length} for key "${key}"`);
            }
          }

          if (batchHasChanges) {
            await batch.commit();

            // Small delay between batches to prevent overwhelming Firestore
            if (i + this.BATCH_SIZE < newChunks.length) {
              await new Promise(resolve => setTimeout(resolve, this.BATCH_DELAY));
            }
          }
        }

        // Delete obsolete chunks
        if (existingChunks.size > 0) {
          const deleteStartTime = Date.now();
          const deleteBatch = this.adapter.writeBatch();
          existingChunks.forEach((_, chunkId) => {
            const docRef = collectionRef.doc(chunkId);
            Log.info(`ChunkManager: Deleting obsolete chunk ${chunkId} for key "${key}"`);
            deleteBatch.delete(docRef);
            metrics.deletedChunks++;
          });
          await deleteBatch.commit();
          metrics.deleteDuration = Date.now() - deleteStartTime;
        }
      }
      metrics.writeDuration = Date.now() - writeStartTime;

      // Clear cache after write
      this.clearCollectionCache(collectionRef);

      const totalDuration = Date.now() - startTime;
      const efficiency = metrics.totalChunks > 0
        ? Math.round((metrics.skippedChunks / metrics.totalChunks) * 100)
        : 0;

      Log.info(
        `ChunkManager: Diff complete in ${totalDuration}ms for key "${key}"\n` +
        `  Total chunks: ${metrics.totalChunks}\n` +
        `  Total fields: ${metrics.totalFields}\n` +
        `  Updated: ${metrics.updatedChunks}\n` +
        `  Skipped: ${metrics.skippedChunks}\n` +
        `  Deleted: ${metrics.deletedChunks}\n` +
        `  Efficiency: ${efficiency}%\n` +
        `  Timing breakdown:\n` +
        `    Read: ${metrics.readDuration}ms\n` +
        `    Chunk gen: ${metrics.chunkGenDuration}ms\n` +
        `    Write: ${metrics.writeDuration}ms\n` +
        `    Delete: ${metrics.deleteDuration}ms`
      );
    } catch (error) {
      // Clear cache on error
      this.clearCollectionCache(collectionRef);

      const totalDuration = Date.now() - startTime;
      Log.error(
        `ChunkManager: Diff failed after ${totalDuration}ms for key "${key}"\n` +
        `  Progress: ${metrics.updatedChunks} updated, ${metrics.skippedChunks} skipped\n` +
        `  Error: ${error}`
      );
      throw error;
    }
  }

  /**
   * Calculates approximate size of data in bytes
   * @param data - The data to measure
   * @private
   */
  private calculateDataSize(data: any): number {
    return calculateDataSize(data);
  }

  /**
   * Compares two chunks for equality using an optimized strategy
   */
  private areChunksEqual(chunk1: any, chunk2: any): boolean {
    return areChunksEqual(chunk1, chunk2);
  }

  /**
   * Check if data needs chunking due to field count, size, or other constraints
   */
  private checkIfNeedsChunking(data: any): { forceChunk: boolean; reason: string } {
    return checkIfNeedsChunking(data);
  }

  /**
   * Reconstructs chunked data from a collection snapshot
   * @param snapshot - The collection snapshot containing the chunks
   * @private
   */
  private reconstructChunkedData(snapshot: FirebaseFirestoreTypes.QuerySnapshot): any {
    return reconstructChunkedData(snapshot);
  }

  /**
   * Enhanced readData with write awareness
   */
  async readData(
    collectionRef: FirebaseFirestoreTypes.CollectionReference,
    options: { requireFresh?: boolean } = {}
  ): Promise<any | undefined> {
    // Wait for any active writes to complete before reading
    const activeLock = this.writeLocks.get(collectionRef.path);
    if (activeLock) {
      Log.info(`ChunkManager: Waiting for active write before reading ${collectionRef.path}`);
      await activeLock.promise;
    }

    try {
      // Use enhanced cache with write awareness
      const snapshot = await this.getCachedCollection(collectionRef, {
        requireFresh: options.requireFresh
      });

      if (snapshot.empty) {
        return undefined;
      }

      // Always reconstruct from chunk_* docs
      const rawData = this.reconstructChunkedData(snapshot);

      // Restore data from Firestore format
      return this.dataProcessor.restoreFromFirestore(rawData);
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError(
        `Failed to read data from collection: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

   /**
   * Debug a problematic write operation
   */
   async debugWriteOperation(
    key: string,
    value: any
  ): Promise<void> {
    Log.info(`🔍 Debugging write operation for key: ${key}`);

    // 1. Analyze original data
    const originalAnalysis = this.dataProcessor.analyzeForFirestoreIssues(value, 'root');
    Log.info(`📊 Original data stats: ${JSON.stringify(originalAnalysis.stats)}`);

    if (originalAnalysis.issues.length > 0) {
      Log.error(`❌ Issues in original data: ${JSON.stringify(originalAnalysis.issues)}`);
    }

    if (originalAnalysis.suspiciousValues.length > 0) {
      Log.error(`⚠️ Suspicious values in original data: ${JSON.stringify(originalAnalysis.suspiciousValues)}`);
      originalAnalysis.suspiciousValues.forEach(sv => {
        Log.error(`  ${sv.path}: ${sv.issue} (type: ${sv.type}, value: ${JSON.stringify(sv.value).substring(0, 100)})`);
      });
    }

    // 2. Check common issues
    const commonIssues = this.dataProcessor.checkCommonIssues(value);
    if (commonIssues.length > 0) {
      Log.error(`🚨 Common issues detected: ${JSON.stringify(commonIssues)}`);
    }

    // 3. Sanitize and analyze again
    const sanitizedValue = this.dataProcessor.sanitizeForFirestore(value);
    const sanitizedAnalysis = this.dataProcessor.analyzeForFirestoreIssues(sanitizedValue, 'root');

    Log.info(`📊 Sanitized data stats: ${JSON.stringify(sanitizedAnalysis.stats)}`);

    if (sanitizedAnalysis.issues.length > 0) {
      Log.error(`Issues in sanitized data: ${JSON.stringify(sanitizedAnalysis.issues)}`);
    }

    if (sanitizedAnalysis.suspiciousValues.length > 0) {
      Log.error(`Suspicious values in sanitized data: ${JSON.stringify(sanitizedAnalysis.suspiciousValues)}`);
      sanitizedAnalysis.suspiciousValues.forEach(sv => {
        Log.error(`  ${sv.path}: ${sv.issue} (type: ${sv.type}, value: ${JSON.stringify(sv.value).substring(0, 100)})`);
      });
    }

    // 4. Try to identify the specific problematic field
    if (typeof sanitizedValue === 'object' && sanitizedValue !== null && !Array.isArray(sanitizedValue)) {
      Log.info(`Testing individual fields for key: ${key}`);

      for (const [fieldKey, fieldValue] of Object.entries(sanitizedValue)) {
        try {
          const testDoc = { [fieldKey]: fieldValue };
          const testAnalysis = this.dataProcessor.analyzeForFirestoreIssues(testDoc);

          if (testAnalysis.suspiciousValues.length > 0 || testAnalysis.issues.length > 0) {
            Log.error(`Problematic field found: ${fieldKey}`);
            Log.error(`   Issues: ${testAnalysis.issues.join(', ')}`);
            Log.error(`   Suspicious values: ${testAnalysis.suspiciousValues.length}`);
          }
        } catch (error) {
          Log.error(`Field analysis failed for ${fieldKey}: ${error}`);
        }
      }
    }

    // 5. Log the final data structure (truncated)
    try {
      const finalDataPreview = JSON.stringify(sanitizedValue, null, 2).substring(0, 1000);
      Log.info(`Final data preview (first 1000 chars):\n${finalDataPreview}`);
    } catch (error) {
      Log.error(`Failed to preview final data: ${error}`);
    }
  }
}