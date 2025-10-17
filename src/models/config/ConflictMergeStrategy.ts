/**
 * Strategies for merging conflicting data during conflict resolution.
 * These define how to combine data from different sources when resolving conflicts.
 */
export enum ConflictMergeStrategy {
  /**
   * Perform a deep merge of nested objects.
   * Recursively merges nested properties while respecting the resolution strategy.
   */
  DEEP_MERGE = 'deep-merge',

  /**
   * Perform a shallow merge at the top level only.
   * Merges top-level properties while respecting the resolution strategy.
   */
  SHALLOW_MERGE = 'shallow-merge',

  /**
   * Perform field-level merge with specific rules.
   * Uses custom logic for merging individual fields.
   */
  FIELD_LEVEL = 'field-level'
}
