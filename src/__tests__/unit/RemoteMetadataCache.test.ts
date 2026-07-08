import RemoteMetadataCache from '../../metadata/remote/RemoteMetadataCache';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import UserManager from '../../managers/UserManager';
import StorageManager from '../../managers/StorageManager';
import { TestStorageMapping, MOCK_CLOUD_BACKUP_CONFIG } from '../../__mocks__/MockConfig';
import { DIGEST_MAP_KEY, REMOTE_METADATA_KEY } from '../../constants';
import IUserManager from '../../models/interfaces/IUserManager';

jest.mock('../../firestore/ref/FirestoreReferenceManager');
jest.mock('../../firestore/FirestoreAdapter');
jest.mock('../../managers/UserManager');
jest.mock('../../managers/StorageManager');

describe('RemoteMetadataCache epoch invalidation', () => {
  let cache: RemoteMetadataCache<TestStorageMapping>;
  let mockAdapter: jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
  let mockDocRef: { id: string; path: string };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDocRef = { id: 'test-doc', path: 'test/path' };

    const mockUserManagerInterface: jest.Mocked<IUserManager> = {
      getCurrentUser: jest.fn(),
      isUserLoggedIn: jest.fn().mockReturnValue(true),
    };

    const mockReferenceManager = new FirestoreReferenceManager(
      mockUserManagerInterface,
      MOCK_CLOUD_BACKUP_CONFIG
    ) as jest.Mocked<FirestoreReferenceManager<TestStorageMapping>>;
    mockReferenceManager.getBackupRef.mockReturnValue({} as any);
    mockReferenceManager.getDocumentRef.mockReturnValue(mockDocRef as any);

    mockAdapter = new FirestoreAdapter({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    }) as jest.Mocked<FirestoreAdapter<TestStorageMapping>>;

    const mockStorage = new StorageManager() as jest.Mocked<StorageManager<TestStorageMapping>>;
    const mockUserManager = new UserManager(
      'email' as keyof TestStorageMapping,
      mockStorage
    ) as jest.Mocked<UserManager<TestStorageMapping>>;
    mockUserManager.isUserLoggedIn.mockReturnValue(true);

    cache = new RemoteMetadataCache(
      mockReferenceManager,
      mockAdapter,
      mockUserManager,
      'settings',
      60_000
    );
  });

  it('discards orphaned fetch write-back when invalidate() bumps epoch mid-flight', async () => {
    let releaseDoc!: () => void;
    const docGate = new Promise<void>(resolve => {
      releaseDoc = () => resolve(undefined);
    });

    mockAdapter.getDocument.mockImplementation(async () => {
      await docGate;
      return {
        exists: true,
        data: () => ({
          [REMOTE_METADATA_KEY]: {},
          [DIGEST_MAP_KEY]: { settings: { d: 'orphan-digest', v: 99 } },
        }),
      } as any;
    });

    const fetchPromise = cache.fetch();
    await Promise.resolve();

    cache.invalidate();

    releaseDoc();
    await fetchPromise;

    expect(cache.getCached()).toEqual({});
  });

  it('invalidate() releases the dedupe handle so the next fetch runs fresh, orphan never clobbers it', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => {
      releaseA = () => resolve(undefined);
    });

    mockAdapter.getDocument
      .mockImplementationOnce(async () => {
        await gateA;
        return {
          exists: true,
          data: () => ({
            [REMOTE_METADATA_KEY]: {},
            [DIGEST_MAP_KEY]: { settings: { d: 'A-digest', v: 1 } },
          }),
        } as any;
      })
      .mockImplementationOnce(
        async () =>
          ({
            exists: true,
            data: () => ({
              [REMOTE_METADATA_KEY]: {},
              [DIGEST_MAP_KEY]: { settings: { d: 'B-digest', v: 2 } },
            }),
          }) as any
      );

    // Session A: fetch in-flight, blocked on gate.
    const fetchA = cache.fetch();
    await Promise.resolve();

    // Teardown boundary: invalidate bumps epoch AND releases A's dedupe handle.
    cache.invalidate();

    // Session B: must NOT dedupe onto A's doomed fetch — runs a fresh getDocument.
    const fetchB = cache.fetch();
    await fetchB;

    expect(mockAdapter.getDocument).toHaveBeenCalledTimes(2);
    expect(cache.getCached()).toEqual({ settings: { d: 'B-digest', v: 2 } });

    // Orphan A resolves late: epoch guard drops its write-back and it must not null B's handle.
    releaseA();
    await fetchA;

    expect(cache.getCached()).toEqual({ settings: { d: 'B-digest', v: 2 } });
  });
});
