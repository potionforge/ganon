import { isFieldDeleteMarker } from '../../firestore/fieldDeleteMarker';

type DocData = Record<string, unknown>;

/**
 * Deep-merge for Firestore merge writes. Shared by jest mock, MockFirestoreAdapter, and FakeFirestore.
 * Field-delete markers remove keys (mirrors FieldValue.delete() on merge).
 */
export function deepMerge(target: DocData, source: DocData): DocData {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isFieldDeleteMarker(value)) {
      delete result[key];
      continue;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as DocData, value as DocData);
    } else {
      result[key] = value;
    }
  }
  return result;
}
