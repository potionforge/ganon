import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { JSONSchema7 } from "json-schema";

export type PrimitiveType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface CloudBackupConfigForDocument<K extends BaseStorageMapping> {
  docKeys?: (Extract<keyof K, string>)[];
  subcollectionKeys?: (Extract<keyof K, string>)[];
  type?: PrimitiveType;
  schema?: JSONSchema7;
}

export interface CloudBackupConfig<K extends BaseStorageMapping> {
  /**
   * [key: string]: document key (e.g. 'history')
   *    docKeys: document keys (e.g. 'grandfathered', 'user', 'deviceId')
   *    subcollectionKeys: subcollection keys (e.g. 'exercises', 'exerciseRecordStats', 'exerciseLastExecutedDateMap', 'notes')
   *    type: primitive type of the data (e.g. 'string', 'number', 'boolean', 'object', 'array')
   *    schema: JSON Schema for validating object/array data
   */
  [key: string]: CloudBackupConfigForDocument<K>;
}
