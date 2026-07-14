type DocData = Record<string, unknown>;

/**
 * Deep-merge for Firestore merge writes. Shared by jest mock, MockFirestoreAdapter, and FakeFirestore.
 * Note: `deleteField()` sentinels are not supported — nothing in Ganon uses them with merge today.
 */
export function deepMerge(target: DocData, source: DocData): DocData {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
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
