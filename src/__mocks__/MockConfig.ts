import { CloudBackupConfig } from '../models/config/CloudBackupConfig';
import { BaseStorageMapping } from '../models/storage/BaseStorageMapping';

// Test Storage Mapping
export interface TestStorageMapping extends BaseStorageMapping {
  email: string | null;
  user: { id: string; name: string; email: string };
  exercises: Record<string, IExercise>;
  count: number;
  notes: string[];
  deletedExerciseKeys: string[];
  startedExercises: IStartedHashMap;
  settings: { theme: 'light' | 'dark'; notifications: boolean };
  stringValue: string;
  numberValue: number;
  booleanValue: boolean;
  arrayValue: string[];
  largeArray: number[];
  largeData: Record<string, any>;
  lastBackup: number;
  // Test keys
  docKey: any;
  nonExistentKey: any;
  subcollectionKey: any;
  workouts: Array<{ id: number; name: string; duration?: number; metadata?: { created: string } }>;
}

export interface IStartedHashMap {
  [key: string]: number | null;
}

export interface IExercise {
  name: string;
  reps: number;
  sets: number;
}

// Shared mock configuration for tests
export const MOCK_CLOUD_BACKUP_CONFIG: CloudBackupConfig<TestStorageMapping> = {
  user: {
    docKeys: ['user', 'count', 'docKey', 'nonExistentKey'],
    subcollectionKeys: ['settings', 'stringValue', 'numberValue', 'booleanValue', 'arrayValue', 'largeArray', 'largeData', 'subcollectionKey', 'workouts']
  },
  exercises: {
    docKeys: ['deletedExerciseKeys'],
    subcollectionKeys: ['exercises', 'startedExercises']
  },
  notes: {
    docKeys: ['notes']
  }
};

// Test data factory functions
export const createTestExercises = (): Record<string, IExercise> => ({
  'exercise1': { name: 'Push-ups', reps: 10, sets: 3 },
  'exercise2': { name: 'Squats', reps: 15, sets: 3 }
} as const);

export const createTestStartedExercises = () => ({
  'exercise1': Date.now(),
  'exercise2': null
} as IStartedHashMap);