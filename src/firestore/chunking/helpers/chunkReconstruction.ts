import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import { SubcollectionPayloadKind } from '../../../models/sync/RemoteDigestEntry';

function mergeChunkDocs(snapshot: FirebaseFirestoreTypes.QuerySnapshot): Record<string, unknown> {
  const chunks = snapshot.docs
    .filter(doc => doc && doc.id && doc.id.startsWith('chunk_'))
    .sort((a, b) => {
      const aIndex = parseInt(a.id.split('_')[1]);
      const bIndex = parseInt(b.id.split('_')[1]);
      return aIndex - bIndex;
    })
    .map(doc => doc.data());

  return chunks.reduce<Record<string, unknown>>((acc, chunk) => ({ ...acc, ...chunk }), {});
}

function isEmptyChunkPayload(data: Record<string, unknown>): boolean {
  const keys = Object.keys(data);
  return keys.length === 0 || (keys.length === 1 && data._empty === true);
}

function stripLoneEmptySentinel(data: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(data);
  if (keys.length === 1 && data._empty === true) {
    return {};
  }
  return data;
}

/** Numeric keys sorted in ascending order; values compact into a dense array (gaps are not preserved). */
function arrayFromNumericKeys(mergedData: Record<string, unknown>): unknown[] {
  const keys = Object.keys(mergedData).filter(k => k !== '_empty' && !Number.isNaN(Number(k)));
  const sortedKeys = keys.map(Number).sort((a, b) => a - b);
  return sortedKeys.map(k => mergedData[String(k)]);
}

function reconstructWithNumericHeuristic(mergedData: Record<string, unknown>): unknown {
  const allKeys = Object.keys(mergedData);
  const numericKeys = allKeys.filter(k => !Number.isNaN(Number(k)));
  if (numericKeys.length === allKeys.length && numericKeys.length > 0) {
    const sortedKeys = numericKeys.map(Number).sort((a, b) => a - b);
    const isContiguous = sortedKeys.every((k, i) => k === i);
    if (isContiguous) {
      return sortedKeys.map(k => mergedData[k]);
    }
  }
  return mergedData;
}

/**
 * Reconstructs chunked data from a collection snapshot
 * @param snapshot - The collection snapshot containing the chunks
 * @param kindHint - Subcollection payload kind from digestMap (E-F4); omit for legacy heuristic
 */
export function reconstructChunkedData(
  snapshot: FirebaseFirestoreTypes.QuerySnapshot,
  kindHint?: SubcollectionPayloadKind
): unknown {
  const mergedData = mergeChunkDocs(snapshot);

  if (kindHint === 'array') {
    if (isEmptyChunkPayload(mergedData)) {
      return [];
    }
    return arrayFromNumericKeys(mergedData);
  }

  if (kindHint === 'object') {
    return stripLoneEmptySentinel(mergedData);
  }

  return reconstructWithNumericHeuristic(mergedData);
}
