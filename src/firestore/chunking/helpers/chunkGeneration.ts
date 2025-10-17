import { calculateDataSize } from './sizeUtils';

const MAX_CHUNK_SIZE = 200_000; // 200KB max per chunk
const MAX_FIELDS_PER_CHUNK = 15000; // Leave room for safety

/**
 * Generates chunks from a value, handling both arrays and objects
 */
export async function generateChunks(value: any): Promise<Array<Record<string, any>>> {
  if (Array.isArray(value)) {
    return generateArrayChunks(value);
  }
  return generateObjectChunks(value);
}

/**
 * Simple, deterministic object chunking - NO SORTING
 * Same input = same chunks every time = efficient diffing
 */
function generateObjectChunks(obj: Record<string, any>): Array<Record<string, any>> {
  const entries = Object.entries(obj); // Natural order - deterministic

  const chunks: Array<Record<string, any>> = [];
  let currentChunk: Record<string, any> = {};
  let currentChunkSize = 0;
  let currentFieldCount = 0;

  for (const [entryKey, entryValue] of entries) {
    // Calculate size only when needed
    const size = calculateDataSize(entryValue);

    // Count fields in this entry
    let entryFieldCount = 1;
    if (entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)) {
      entryFieldCount += Object.keys(entryValue).length;
    }

    // Simple decision: create new chunk if limits exceeded
    const wouldExceedSize = currentChunkSize + size > MAX_CHUNK_SIZE;
    const wouldExceedFields = currentFieldCount + entryFieldCount > MAX_FIELDS_PER_CHUNK;

    if ((wouldExceedSize || wouldExceedFields) && Object.keys(currentChunk).length > 0) {
      chunks.push(currentChunk);
      currentChunk = {};
      currentChunkSize = 0;
      currentFieldCount = 0;
    }

    currentChunk[entryKey] = entryValue;
    currentChunkSize += size;
    currentFieldCount += entryFieldCount;
  }

  if (Object.keys(currentChunk).length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Simple array chunking - maintain original indices
 */
function generateArrayChunks(array: any[]): Array<Record<string, any>> {
  const chunks: Array<Record<string, any>> = [];
  let currentChunk: Record<string, any> = {};
  let currentChunkSize = 0;
  let currentFieldCount = 0;

  for (let i = 0; i < array.length; i++) {
    const item = array[i];
    const size = calculateDataSize(item);

    // Count fields
    let itemFieldCount = 1;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      itemFieldCount += Object.keys(item).length;
    }

    // Check limits
    const wouldExceedSize = currentChunkSize + size > MAX_CHUNK_SIZE;
    const wouldExceedFields = currentFieldCount + itemFieldCount > MAX_FIELDS_PER_CHUNK;

    if ((wouldExceedSize || wouldExceedFields) && Object.keys(currentChunk).length > 0) {
      chunks.push(currentChunk);
      currentChunk = {};
      currentChunkSize = 0;
      currentFieldCount = 0;
    }

    currentChunk[String(i)] = item; // Maintain original array index
    currentChunkSize += size;
    currentFieldCount += itemFieldCount;
  }

  if (Object.keys(currentChunk).length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
