# Chunking Behavior Changes

## Current Behavior
Currently, when chunking arrays, the `ChunkManager` writes chunks as objects with a `value` property containing the array chunk. For example:

```javascript
// Input array: [1, 2, 3, 4, 5]
// Current chunk format:
{
  value: [1, 2, 3]  // chunk_0
}
{
  value: [4, 5]     // chunk_1
}
```

## Desired Behavior
The tests expect chunked arrays to be written as objects with numeric keys, making it easier to reconstruct the array later. For example:

```javascript
// Input array: [1, 2, 3, 4, 5]
// Desired chunk format:
{
  "0": 1,
  "1": 2,
  "2": 3
}  // chunk_0
{
  "3": 4,
  "4": 5
}  // chunk_1
```

## Required Changes

1. Modify `ChunkManager.writeChunkedData` to handle arrays differently from objects:
   - For arrays: Write chunks as objects with numeric keys
   - For objects: Keep existing behavior (write as is)

2. Update `ChunkManager.reconstructChunkedData` to handle array reconstruction:
   - When all keys are numeric, reconstruct as an array
   - For objects, keep existing behavior

3. Update `ChunkManager.writeChunk` to handle array chunks:
   - For arrays: Convert chunk entries to object with numeric keys
   - For objects: Keep existing behavior

## Implementation Details

The main changes will be in `ChunkManager.ts`:

1. In `writeChunkedData`:
   ```typescript
   const entries: Array<[string, any]> = Array.isArray(value)
     ? value.map((v: any, i: number) => [String(i), v] as [string, any])
     : Object.entries(value);
   ```

2. In `writeChunk`:
   ```typescript
   const chunkObject = Array.isArray(value)
     ? Object.fromEntries(chunkEntries)  // Will create object with numeric keys
     : this.dataProcessor.sanitize(Object.fromEntries(chunkEntries));
   ```

3. In `reconstructChunkedData`:
   ```typescript
   const allKeys = Object.keys(mergedData);
   const isArray = allKeys.every(k => !isNaN(Number(k)));
   return isArray
     ? allKeys.sort((a, b) => Number(a) - Number(b)).map(k => mergedData[k])
     : mergedData;
   ```

## Testing
The changes will be verified against the existing test suite, particularly:
- `should chunk large arrays properly without wrapping`
- `should NOT wrap large objects (existing chunking behavior)`
- All other chunking-related tests to ensure no regressions

## Benefits
1. More efficient array reconstruction
2. Consistent with test expectations
3. Better data structure preservation
4. No impact on existing object chunking behavior 