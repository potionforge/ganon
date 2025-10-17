import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { JSONSchema7 } from "json-schema";

export interface CloudBackupConfigForDocument<K extends BaseStorageMapping> {
  docKeys?: (Extract<keyof K, string>)[];
  subcollectionKeys?: (Extract<keyof K, string>)[];
  schema?: JSONSchema7;
}

export interface CloudBackupConfig<K extends BaseStorageMapping> {
  /**
   * [key: string]: document key (e.g. 'history')
   *    docKeys: document keys (e.g. 'grandfathered', 'user', 'deviceId')
   *    subcollectionKeys: subcollection keys (e.g. 'exercises', 'exerciseRecordStats', 'exerciseLastExecutedDateMap', 'notes')
   *    schema: JSON Schema for validating object/array data
   */
  [key: string]: CloudBackupConfigForDocument<K>;
}
