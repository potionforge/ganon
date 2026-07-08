/**
 * Minimal MMKV-shaped storage port for constructor injection and test doubles.
 */
export interface KeyValueStore {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  contains(key: string): boolean;
  clearAll(): void;
}
