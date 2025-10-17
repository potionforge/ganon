import Log from "../../../utils/Log";

/**
 * Fast hash function optimized for large objects with enhanced collision resistance
 */
function fastHash(obj: any): string {
  try {
    let str: string;

    if (typeof obj === 'object' && obj !== null) {
      const keys = Object.keys(obj);
      if (keys.length > 1000) {
        // Enhanced summary for very large objects
        const sortedKeys = keys.sort(); // Sort for consistency
        str = `${keys.length}_${sortedKeys.slice(0, 20).join('')}_${sortedKeys.slice(-20).join('')}`;

        // Add more distribution points for better collision resistance
        const quarterPoint = Math.floor(keys.length / 4);
        const halfPoint = Math.floor(keys.length / 2);
        const threeQuarterPoint = Math.floor(keys.length * 3 / 4);

        str += `_${sortedKeys.slice(quarterPoint, quarterPoint + 10).join('')}`;
        str += `_${sortedKeys.slice(halfPoint, halfPoint + 10).join('')}`;
        str += `_${sortedKeys.slice(threeQuarterPoint, threeQuarterPoint + 10).join('')}`;

        // Add a sample of values for better uniqueness
        const sampleValues = sortedKeys.slice(0, 10).map(k => {
          const val = obj[k];
          if (typeof val === 'object') return typeof val;
          return String(val).substring(0, 10);
        }).join('|');
        str += `_${sampleValues}`;
      } else {
        str = JSON.stringify(obj);
      }
    } else {
      str = JSON.stringify(obj);
    }

    // Use a better hash algorithm (FNV-1a variant)
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash *= 16777619;
    }
    return (hash >>> 0).toString(36); // Convert to base36 for shorter strings
  } catch {
    return 'hash_failed';
  }
}

/**
 * Sampling-based comparison for very large chunks
 */
function sampledComparison(chunk1: any, chunk2: any, keys: string[]): boolean {
  // Use a larger sample size for more accuracy
  const sampleSize = Math.min(200, Math.max(100, Math.floor(keys.length * 0.01))); // 1% or min 100, max 200

  // Use deterministic sampling instead of random to ensure consistency
  const step = Math.floor(keys.length / sampleSize);
  const sampleKeys: string[] = [];

  for (let i = 0; i < keys.length; i += step) {
    sampleKeys.push(keys[i]);
    if (sampleKeys.length >= sampleSize) break;
  }

  Log.verbose(`ChunkComparison: Sampling ${sampleKeys.length} keys out of ${keys.length}`);

  for (const key of sampleKeys) {
    const val1 = chunk1[key];
    const val2 = chunk2[key];

    if (val1 !== val2) {
      // For objects, do a quick comparison
      if (typeof val1 === 'object' && typeof val2 === 'object') {
        if (val1 === null || val2 === null) {
          if (val1 !== val2) return false;
        } else {
          // Quick size check first
          const keys1 = Object.keys(val1);
          const keys2 = Object.keys(val2);
          if (keys1.length !== keys2.length) return false;

          // For small nested objects, do full comparison
          if (keys1.length < 5) {
            if (JSON.stringify(val1) !== JSON.stringify(val2)) return false;
          } else {
            // For larger nested objects, use hash
            if (fastHash(val1) !== fastHash(val2)) return false;
          }
        }
      } else {
        return false;
      }
    }
  }

  // If sampling passes, do final hash verification
  const hash1 = fastHash(chunk1);
  const hash2 = fastHash(chunk2);
  const result = hash1 === hash2 && hash1 !== 'hash_failed';

  Log.verbose(`ChunkComparison: Final hash verification: ${result}`);
  return result;
}

/**
 * Optimized detailed comparison
 */
function detailedComparison(chunk1: any, chunk2: any, keys: string[]): boolean {
  for (const key of keys) {
    if (!(key in chunk2)) return false;

    const val1 = chunk1[key];
    const val2 = chunk2[key];

    if (val1 !== val2) {
      // For objects, use fast comparison methods
      if (typeof val1 === 'object' && typeof val2 === 'object') {
        if (val1 === null || val2 === null) return val1 === val2;

        // Quick property count check
        const objKeys1 = Object.keys(val1);
        const objKeys2 = Object.keys(val2);
        if (objKeys1.length !== objKeys2.length) return false;

        // For small objects, use JSON comparison
        if (objKeys1.length < 10) {
          if (JSON.stringify(val1) !== JSON.stringify(val2)) return false;
        } else {
          // For larger objects, use hash comparison
          if (fastHash(val1) !== fastHash(val2)) return false;
        }
      } else {
        return false;
      }
    }
  }
  return true;
}

/**
 * Compares two chunks for equality using an optimized strategy
 */
export function areChunksEqual(chunk1: any, chunk2: any): boolean {
  const startTime = Date.now();

  try {
    // Quick checks first
    if (chunk1 === chunk2) {
      Log.verbose(`ChunkComparison: Chunks identical by reference`);
      return true;
    }
    if (!chunk1 || !chunk2) {
      Log.verbose(`ChunkComparison: One chunk is null/undefined`);
      return false;
    }

    const keys1 = Object.keys(chunk1);
    const keys2 = Object.keys(chunk2);

    // Different number of keys = different chunks
    if (keys1.length !== keys2.length) {
      Log.verbose(`ChunkComparison: Different key counts: ${keys1.length} vs ${keys2.length}`);
      return false;
    }

    Log.verbose(`ChunkComparison: Comparing chunks with ${keys1.length} fields`);

    // CRITICAL: For your use case, try hash comparison first before sampling
    // because sampling might be giving false positives
    if (keys1.length > 1000) {
      const hash1 = fastHash(chunk1);
      const hash2 = fastHash(chunk2);

      if (hash1 !== 'hash_failed' && hash2 !== 'hash_failed') {
        const hashesMatch = hash1 === hash2;
        Log.verbose(`ChunkComparison: Hash comparison result: ${hashesMatch} (${hash1} vs ${hash2})`);

        if (!hashesMatch) {
          const duration = Date.now() - startTime;
          Log.verbose(`ChunkComparison: Hash comparison completed in ${duration}ms - chunks different`);
          return false;
        }

        // Hashes match - do a sampling verification for safety
        if (keys1.length > 5000) {
          const samplingResult = sampledComparison(chunk1, chunk2, keys1);
          const duration = Date.now() - startTime;
          Log.verbose(`ChunkComparison: Sampling verification completed in ${duration}ms - result: ${samplingResult}`);
          return samplingResult;
        }
      }
    }

    // Sampling for very large chunks (>5000 fields) - only if hash failed
    if (keys1.length > 5000) {
      const samplingResult = sampledComparison(chunk1, chunk2, keys1);
      const duration = Date.now() - startTime;
      Log.verbose(`ChunkComparison: Sampling comparison completed in ${duration}ms - result: ${samplingResult}`);
      return samplingResult;
    }

    // Detailed comparison for smaller chunks
    const detailedResult = detailedComparison(chunk1, chunk2, keys1);
    const duration = Date.now() - startTime;
    Log.verbose(`ChunkComparison: Detailed comparison completed in ${duration}ms - result: ${detailedResult}`);
    return detailedResult;

  } catch (error) {
    const duration = Date.now() - startTime;
    Log.warn(`ChunkComparison: Chunk comparison failed after ${duration}ms, assuming chunks are different: ${error}`);
    return false;
  }
}
