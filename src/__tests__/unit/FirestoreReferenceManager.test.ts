import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { FakeFirestore } from '../utils/FakeFirestore';

jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

jest.mock('@react-native-firebase/firestore');

interface TestMapping extends BaseStorageMapping {
  knownKey: string;
  unknownKey: string;
}

const cloudConfig = {
  settings: {
    docKeys: ['knownKey'] as Extract<keyof TestMapping, string>[],
    subcollectionKeys: [] as Extract<keyof TestMapping, string>[],
  },
};

describe('FirestoreReferenceManager', () => {
  it('throws the legacy error message for unknown keys', () => {
    const fake = new FakeFirestore();
    const manager = new FirestoreReferenceManager<TestMapping>(
      { getCurrentUser: () => 'alice' },
      cloudConfig,
      fake.module
    );

    expect(() => manager.getRefForKey('unknownKey')).toThrow(
      'Ganon: key unknownKey not found in cloudConfig'
    );
    expect(() => manager.getDocumentRefForKey('unknownKey')).toThrow(
      'Ganon: key unknownKey not found in cloudConfig'
    );
  });
});
