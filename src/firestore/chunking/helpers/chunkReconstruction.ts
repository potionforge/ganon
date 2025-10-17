import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';

/**
 * Reconstructs chunked data from a collection snapshot
 * @param snapshot - The collection snapshot containing the chunks
 */
export function reconstructChunkedData(snapshot: FirebaseFirestoreTypes.QuerySnapshot): any {
  const chunks = snapshot.docs
    .filter(doc => doc && doc.id && doc.id.startsWith('chunk_'))
    .sort((a, b) => {
      const aIndex = parseInt(a.id.split('_')[1]);
      const bIndex = parseInt(b.id.split('_')[1]);
      return aIndex - bIndex;
    })
    .map(doc => doc.data());

  const mergedData = chunks.reduce((acc, chunk) => ({ ...acc, ...chunk }), {});

  // Check if this was an array (all keys are numeric, contiguous, and start at 0)
  const allKeys = Object.keys(mergedData);
  const numericKeys = allKeys.filter(k => !isNaN(Number(k)));
  if (
    numericKeys.length === allKeys.length &&
    numericKeys.length > 0
  ) {
    // Check for contiguous keys starting at 0
    const sortedKeys = numericKeys.map(Number).sort((a, b) => a - b);
    const isContiguous = sortedKeys.every((k, i) => k === i);
    if (isContiguous) {
      // Reconstruct as array
      return sortedKeys.map(k => mergedData[k]);
    }
  }
  // Otherwise, return as object (preserve original keys)
  return mergedData;
} 