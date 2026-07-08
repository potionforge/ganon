import KeyRouter from '../../routing/KeyRouter';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';

interface TestMapping extends BaseStorageMapping {
  userId: string;
  key1: string;
  key2: string;
  bigData: Record<string, string>;
  lastBackup: number;
}

describe('KeyRouter', () => {
  const cloudConfig = {
    profile: {
      docKeys: ['key1', 'key2'] as Extract<keyof TestMapping, string>[],
      subcollectionKeys: [] as Extract<keyof TestMapping, string>[],
    },
    data: {
      docKeys: [] as Extract<keyof TestMapping, string>[],
      subcollectionKeys: ['bigData'] as Extract<keyof TestMapping, string>[],
    },
  };

  let router: KeyRouter<TestMapping>;

  beforeEach(() => {
    router = new KeyRouter<TestMapping>(cloudConfig);
  });

  it('routes docField keys', () => {
    expect(router.route('key1')).toEqual({ document: 'profile', kind: 'docField' });
  });

  it('routes subcollection keys', () => {
    expect(router.route('bigData')).toEqual({ document: 'data', kind: 'subcollection' });
  });

  it('returns undefined for unknown keys', () => {
    expect(router.route('userId')).toBeUndefined();
  });

  it('isCloudKey reflects cloudConfig membership', () => {
    expect(router.isCloudKey('key1')).toBe(true);
    expect(router.isCloudKey('userId')).toBe(false);
  });

  it('allCloudKeys returns every configured key', () => {
    expect(router.allCloudKeys().sort()).toEqual(['bigData', 'key1', 'key2']);
  });
});
