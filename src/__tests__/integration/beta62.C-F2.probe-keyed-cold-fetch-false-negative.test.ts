/**
 * beta62.C-F2: keyed metadata fetch must not warm an empty partial cache (false-negative probe).
 */
import MetadataCoordinator from '../../metadata/remote/MetadataCoordinator';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import LocalMetadataManager from '../../metadata/local/LocalMetadataManager';
import UserManager from '../../managers/UserManager';
import StorageManager from '../../managers/StorageManager';
import MetadataManager from '../../metadata/MetadataManager';
import MetadataCoordinatorRepo from '../../metadata/MetadataCoordinatorRepo';
import { MOCK_CLOUD_BACKUP_CONFIG, TestStorageMapping } from '../../__mocks__/MockConfig';
import { REMOTE_METADATA_KEY } from '../../constants';
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import IUserManager from '../../models/interfaces/IUserManager';

jest.mock('../../firestore/ref/FirestoreReferenceManager');
jest.mock('../../firestore/FirestoreAdapter');

describe('beta62.C-F2 probe keyed cold-cache false negative', () => {
  const remoteMeta = {
    count: { d: 'hash-count', v: 10 },
  };

  let mockAdapter: jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
  let mockReferenceManager: jest.Mocked<FirestoreReferenceManager<TestStorageMapping>>;
  let mockDocRef: FirebaseFirestoreTypes.DocumentReference;

  beforeEach(() => {
    jest.clearAllMocks();

    mockDocRef = { id: 'user', path: 'users/u1/backup/user' } as FirebaseFirestoreTypes.DocumentReference;

    const mockUserManagerInterface = {
      getCurrentUser: jest.fn().mockReturnValue('u1'),
      isUserLoggedIn: jest.fn().mockReturnValue(true),
    } as jest.Mocked<IUserManager>;

    mockReferenceManager = new FirestoreReferenceManager(
      mockUserManagerInterface,
      MOCK_CLOUD_BACKUP_CONFIG
    ) as jest.Mocked<FirestoreReferenceManager<TestStorageMapping>>;
    mockReferenceManager.getDocumentRef.mockReturnValue(mockDocRef);
    mockReferenceManager.getBackupRef.mockReturnValue({} as FirebaseFirestoreTypes.CollectionReference);

    mockAdapter = new FirestoreAdapter({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    }) as jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
    mockAdapter.getDocument.mockResolvedValue({
      exists: true,
      data: () => ({ [REMOTE_METADATA_KEY]: remoteMeta }),
    } as FirebaseFirestoreTypes.DocumentSnapshot);
  });

  it('keyed getRemoteMetadata leaves sibling keys on the warm cache', async () => {
    const storage = new StorageManager<TestStorageMapping>();
    storage.set('email', 'u1@example.com');
    const userManager = new UserManager('email', storage);
    const coordinator = new MetadataCoordinator(
      mockReferenceManager,
      mockAdapter,
      new LocalMetadataManager(storage),
      userManager,
      'user'
    );

    await coordinator.getRemoteMetadata(['user']);
    const after = await coordinator.getRemoteMetadata(['count']);
    expect(after.count).toEqual(remoteMeta.count);
  });

  it('probeRemoteTenure finds tenure on a later key when the first configured key is absent remotely', async () => {
    const storage = new StorageManager<TestStorageMapping>();
    storage.set('email', 'u1@example.com');
    const userManager = new UserManager('email', storage);
    const localMetadata = new LocalMetadataManager(storage);
    const coordinatorRepo = new MetadataCoordinatorRepo(
      MOCK_CLOUD_BACKUP_CONFIG,
      mockAdapter,
      mockReferenceManager,
      localMetadata,
      userManager
    );

    const metadataManager = new MetadataManager(
      { identifierKey: 'email', cloudConfig: MOCK_CLOUD_BACKUP_CONFIG, autoStartSync: false },
      coordinatorRepo,
      localMetadata
    );

    const allKeys = [
      'user',
      'count',
      'docKey',
      'nonExistentKey',
      'settings',
      'stringValue',
      'numberValue',
      'booleanValue',
      'arrayValue',
      'largeArray',
      'largeData',
      'subcollectionKey',
      'workouts',
      'deletedExerciseKeys',
      'exercises',
      'startedExercises',
      'notes',
    ] as Extract<keyof TestStorageMapping, string>[];

    const { present, errors } = await metadataManager.probeRemoteTenure(allKeys);
    expect(errors).toEqual([]);
    expect(present).toBe(true);
  });
});
