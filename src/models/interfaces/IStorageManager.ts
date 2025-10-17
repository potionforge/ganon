import { BaseStorageMapping } from "../storage/BaseStorageMapping";

export interface IStorageManager<T extends BaseStorageMapping> {
  get<K extends keyof T>(dbKey: K): T[K] | undefined;
  set<K extends keyof T>(dbKey: K, data: T[K]): void;
  remove<K extends keyof T>(dbKey: K): void;
  upsert<K extends keyof T>(dbKey: K, data: T[K]): void;
  contains<K extends keyof T>(dbKey: K): boolean;
  clearAllData(): void;
}
