import { CloudBackupConfig } from "../config/CloudBackupConfig";
import { BaseStorageMapping } from "../storage/BaseStorageMapping";

// Remote metadata contains only digest and version for cloud backup
export interface RemoteMetadata {
  digest: string;
  version: number;
}

export interface ICloudManager<T extends BaseStorageMapping> {
  identifierKey: string;
  cloudConfig: CloudBackupConfig<T>;

  // Cloud operations
  backup(key: Extract<keyof T, string>, value: any): Promise<void>;
  fetch(key: Extract<keyof T, string>): Promise<T[keyof T] | undefined>;
  delete(key: Extract<keyof T, string>): Promise<void>;
  dangerouslyDelete(): Promise<void>;
}
