import { MMKV } from "react-native-mmkv";
import { IStorageManager } from "../models/interfaces/IStorageManager";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import Log from "../utils/Log";
import { METADATA_KEY } from "../constants";
export default class StorageManager<T extends BaseStorageMapping> implements IStorageManager<T> {
  private storage: MMKV;
  private cache: Partial<T> = {};
  private static readonly MAX_CACHE_SIZE = 100;
  private cacheKeys: string[] = []; // track access order

  constructor() {
    this.storage = new MMKV();
  }

  get<K extends keyof T>(dbKey: K): T[K] | undefined {
    if (Object.prototype.hasOwnProperty.call(this.cache, dbKey)) {
      const value = this.cache[dbKey];
      this._updateCache(dbKey, value);
      return value;
    }

    try {
      const data = this.storage.getString(String(dbKey));
      if (data) {
        const parsedData = JSON.parse(data) as T[K];
        this._updateCache(dbKey, parsedData);
        return parsedData;
      }
      this._updateCache(dbKey, undefined);
      return undefined;
    } catch (error) {
      Log.error("Ganon: Error retrieving data:" + JSON.stringify(error));
      return undefined;
    }
  }

  set<K extends keyof T>(dbKey: K, data: T[K]): void {
    if (Log.loglevel >= 1 && dbKey !== METADATA_KEY) {
      Log.info(`Ganon: Saving data for key: ${String(dbKey)}`);
    }
    try {
      this._updateCache(dbKey, data);
      this.storage.set(String(dbKey), JSON.stringify(data));
    } catch (error) {
      Log.error("Ganon: Error saving data:" + JSON.stringify(error));
    }
  }

  remove<K extends keyof T>(dbKey: K): void {
    if (Log.loglevel >= 1) {
      Log.info(`Ganon: Removing data for key: ${String(dbKey)}`);
    }
    try {
      delete this.cache[dbKey];
      this.storage.delete(String(dbKey));
    } catch (error) {
      Log.error("Ganon: Error removing data:" + JSON.stringify(error));
    }
  }

  upsert<K extends keyof T>(dbKey: K, data: Partial<T[K]>): void {
    if (Log.loglevel >= 1) {
      Log.info(`Ganon: Upserting data for key: ${String(dbKey)}`);
    }
    try {
      if (this.contains(dbKey)) {
        const existingData = this.get(dbKey);
        if (existingData) {
          const updatedData = { ...existingData, ...data } as T[K];
          this.set(dbKey, updatedData);
        } else {
          this.set(dbKey, data as T[K]);
        }
      } else {
        this.set(dbKey, data as T[K]);
      }
    } catch (error) {
      Log.error("Ganon: Error upserting data:" + JSON.stringify(error));
    }
  }

  contains<K extends keyof T>(dbKey: K): boolean {
    return this.storage.contains(String(dbKey));
  }

  clearAllData(): void {
    Log.info("Ganon: Clearing all data");
    this.storage.clearAll();
    this.cache = {};
  }

  private _updateCache<K extends keyof T>(dbKey: K, value?: T[K]): void {
    if (value === undefined) {
      delete this.cache[dbKey];
      const keyStr = String(dbKey);
      const index = this.cacheKeys.indexOf(keyStr);
      if (index > -1) {
        this.cacheKeys.splice(index, 1);
      }
      return;
    }

    this.cache[dbKey] = value;
    const keyStr = String(dbKey);
    const index = this.cacheKeys.indexOf(keyStr);

    if (index > -1) {
      this.cacheKeys.splice(index, 1);
    }

    this.cacheKeys.push(keyStr);

    if (this.cacheKeys.length > StorageManager.MAX_CACHE_SIZE) {
      const oldestKey = this.cacheKeys.shift();
      if (oldestKey) {
        delete this.cache[oldestKey as keyof T];
      }
    }
  }
}
