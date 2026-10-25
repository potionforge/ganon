import StorageManager from '../../managers/StorageManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import MetadataStore from '../../metadata/local/MetadataStore';
import MetadataCoordinatorRepo from '../../metadata/MetadataCoordinatorRepo';
import MetadataManager from '../../metadata/MetadataManager';
import OperationRepo from '../../sync/OperationRepo';
import SyncEngine from '../../sync/SyncEngine';
import NetworkMonitor from '../../utils/NetworkMonitor';
import UserManager from '../../managers/UserManager';
import { GanonConfig, InternalGanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { resolveGanonConfig } from '../../models/config/resolveGanonConfig';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeFirestore } from './FakeFirestore';
import { FakeScheduler } from './FakeScheduler';
import { FakeClock } from './FakeClock';
import { KeyValueStore } from '../../ports/KeyValueStore';
import KeyRouter from '../../routing/KeyRouter';
import computeHash from '../../utils/computeHash';
import { DIGEST_MAP_KEY, REMOTE_METADATA_KEY } from '../../constants';

export interface SixTwoStorage extends BaseStorageMapping {
  email: string;
  alpha: string;
  beta: string;
  gamma: string;
  lastBackup: number;
}

export const SIX_TWO_USER = 'user-6two-integration';
export const SIX_TWO_CLOUD_KEYS = ['alpha', 'beta', 'gamma'] as const;

export const SIX_TWO_CLOUD_CONFIG: GanonConfig<SixTwoStorage>['cloudConfig'] = {
  profile: {
    docKeys: [...SIX_TWO_CLOUD_KEYS],
    subcollectionKeys: [],
  },
};

export function seedRemoteProfile(
  fake: FakeFirestore,
  userId: string,
  values: Record<(typeof SIX_TWO_CLOUD_KEYS)[number], string>
): void {
  const meta: Record<string, { d: string; v: number }> = {};
  const docPayload: Record<string, unknown> = {};
  for (const key of SIX_TWO_CLOUD_KEYS) {
    docPayload[key] = values[key];
    meta[key] = { d: computeHash(values[key]), v: 500 };
  }
  docPayload[REMOTE_METADATA_KEY] = meta;
  docPayload[DIGEST_MAP_KEY] = meta;
  fake.setDocument(`users/${userId}/backup/profile`, docPayload);
}

export type SixTwoHarness = {
  fake: FakeFirestore;
  adapter: FirestoreAdapter<SixTwoStorage>;
  firestoreManager: FirestoreManager<SixTwoStorage>;
  syncEngine: SyncEngine<SixTwoStorage>;
  metadataManager: MetadataManager<SixTwoStorage>;
  storage: StorageManager<SixTwoStorage>;
  operationRepo: OperationRepo<SixTwoStorage>;
  networkMonitor: NetworkMonitor;
  userManager: UserManager<SixTwoStorage>;
  keyRouter: KeyRouter<SixTwoStorage>;
  scheduler: FakeScheduler;
  clock: FakeClock;
  userId: string;
  profileBackupPath: string;
  userDocPath: string;
};

export function createSixTwoStack(
  config: InternalGanonConfig<SixTwoStorage>,
  userId: string = SIX_TWO_USER
): SixTwoHarness {
  const fake = new FakeFirestore();
  const scheduler = new FakeScheduler();
  const clock = new FakeClock();
  clock.set(1_700_000_000_000);
  const storageKv = new MMKVFaker();
  const operationsKv = new MMKVFaker();
  const storage = new StorageManager<SixTwoStorage>(storageKv);
  const resolved = resolveGanonConfig(config);
  const userManager = new UserManager<SixTwoStorage>('email', storage);
  const adapter = new FirestoreAdapter(config, fake.module);
  const referenceManager = new FirestoreReferenceManager(
    userManager,
    config.cloudConfig,
    fake.module
  );
  const firestoreManager = new FirestoreManager(
    config.identifierKey,
    config.cloudConfig,
    adapter,
    userManager,
    referenceManager,
    scheduler
  );
  const metadataStore = new MetadataStore<SixTwoStorage>(storage);
  const coordinatorRepo = new MetadataCoordinatorRepo(
    config.cloudConfig,
    adapter,
    referenceManager,
    metadataStore,
    userManager,
    resolved,
    scheduler
  );
  const keyRouter = new KeyRouter(config.cloudConfig);
  const metadataManager = new MetadataManager(
    config,
    coordinatorRepo,
    metadataStore,
    keyRouter
  );
  const networkMonitor = new NetworkMonitor();
  jest.spyOn(networkMonitor, 'isOnline').mockReturnValue(true);
  const operationRepo = new OperationRepo<SixTwoStorage>(
    networkMonitor,
    {
      storage,
      firestore: firestoreManager,
      metadataManager,
    },
    operationsKv as unknown as KeyValueStore
  );
  const syncEngine = new SyncEngine(
    storage,
    firestoreManager,
    metadataManager,
    operationRepo,
    userManager,
    config,
    clock,
    scheduler,
    keyRouter
  );

  return {
    fake,
    adapter,
    firestoreManager,
    syncEngine,
    metadataManager,
    storage,
    operationRepo,
    networkMonitor,
    userManager,
    keyRouter,
    scheduler,
    clock,
    userId,
    profileBackupPath: `users/${userId}/backup/profile`,
    userDocPath: `users/${userId}`,
  };
}

/** Count adapter writes targeting the profile backup doc (value/digest backups). */
export function countProfileBackupWrites(
  adapter: FirestoreAdapter<SixTwoStorage>,
  profilePath: string
): number {
  const matchesPath = (call: unknown[]) => {
    const ref = call.length > 1 && call[0] && typeof call[0] === 'object' && 'path' in (call[0] as object)
      ? (call[0] as { path: string })
      : (call[1] as { path: string });
    return ref.path === profilePath;
  };
  const setCalls = (adapter.setDocument as jest.Mock).mock.calls.filter(matchesPath);
  const txCalls = (adapter.setDocumentWithTransaction as jest.Mock).mock.calls.filter(matchesPath);
  return setCalls.length + txCalls.length;
}
