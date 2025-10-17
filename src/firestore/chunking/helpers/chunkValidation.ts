import { calculateDataSize } from './sizeUtils';

const MAX_CHUNK_SIZE = 200_000; // 200KB max per chunk
const SAFE_FIELD_THRESHOLD = 19000; // Leave room below Firestore's 20k limit

export interface ChunkingValidation {
  forceChunk: boolean;
  reason: string;
}

/**
 * Check if data needs chunking due to field count, size, or other constraints
 */
export function checkIfNeedsChunking(data: any): ChunkingValidation {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { forceChunk: false, reason: '' };
  }

  // Check data size FIRST (most important optimization)
  const dataSize = calculateDataSize(data);
  if (dataSize > MAX_CHUNK_SIZE) {
    return {
      forceChunk: true,
      reason: `Data size (${dataSize} bytes) exceeds chunk size limit (${MAX_CHUNK_SIZE} bytes)`
    };
  }

  const fieldCount = Object.keys(data).length;

  // Force chunking if we're close to the 20,000 field limit
  if (fieldCount > SAFE_FIELD_THRESHOLD) {
    return {
      forceChunk: true,
      reason: `Field count (${fieldCount}) exceeds safe threshold (${SAFE_FIELD_THRESHOLD})`
    };
  }

  // Check for nested objects that might push us over the limit
  let totalNestedFields = 0;
  let hasLargeNestedObject = false;

  for (const value of Object.values(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nestedFieldCount = Object.keys(value).length;
      totalNestedFields += nestedFieldCount;

      // Flag if any single nested object is very large
      if (nestedFieldCount > SAFE_FIELD_THRESHOLD * 0.5) {
        hasLargeNestedObject = true;
      }
    }
  }

  // Check total field count including nested fields
  if (fieldCount + totalNestedFields > SAFE_FIELD_THRESHOLD) {
    return {
      forceChunk: true,
      reason: `Total field count including nested (${fieldCount + totalNestedFields}) exceeds safe threshold (${SAFE_FIELD_THRESHOLD})`
    };
  }

  // Force chunking if any single nested object is very large
  if (hasLargeNestedObject) {
    return {
      forceChunk: true,
      reason: 'Contains a very large nested object that should be chunked separately'
    };
  }

  return { forceChunk: false, reason: '' };
}
