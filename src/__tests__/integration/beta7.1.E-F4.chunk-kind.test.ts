/**
 * E-F4: digestMap carries subcollection payload kind; reconstruction uses kindHint.
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import MetadataManager from '../../metadata/MetadataManager';
import MetadataCoordinatorRepo from '../../metadata/MetadataCoordinatorRepo';
import MetadataStore from '../../metadata/local/MetadataStore';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreManager from '../../firestore/FirestoreManager';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import UserManager from '../../managers/UserManager';
import StorageManager from '../../managers/StorageManager';
import KeyRouter from '../../routing/KeyRouter';
import { GanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { resolveGanonConfig } from '../../models/config/resolveGanonConfig';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeFirestore } from '../utils/FakeFirestore';
import { FakeScheduler } from '../utils/FakeScheduler';
import computeHash from '../../utils/computeHash';
import SessionToken from '../../sync/SessionToken';
import { DIGEST_MAP_KEY } from '../../constants';
import { reconstructChunkedData } from '../../firestore/chunking/helpers/chunkReconstruction';
import ChunkManager from '../../firestore/chunking/ChunkManager';

interface Ef4Storage extends BaseStorageMapping {
  email: string;
  listKey: unknown;
}

const USER = 'ef4-user';
const session = SessionToken.forTests(USER);
const PROFILE_PATH = `users/${USER}/backup/profile`;
const COLL_PATH = `${PROFILE_PATH}/listKey`;

const config: GanonConfig<Ef4Storage> = {
  identifierKey: 'email',
  cloudConfig: {
    profile: {
      docKeys: [],
      subcollectionKeys: ['listKey'],
    },
  },
  autoStartSync: false,
  syncInterval: 60_000,
};

function createHarness(fake: FakeFirestore) {
  const storage = new StorageManager<Ef4Storage>(new MMKVFaker());
  storage.set('email', USER);
  const userManager = new UserManager<Ef4Storage>('email', storage);
  const adapter = new FirestoreAdapter(config, fake.module);
  const referenceManager = new FirestoreReferenceManager(userManager, config.cloudConfig, fake.module);
  const scheduler = new FakeScheduler();
  const firestoreManager = new FirestoreManager(
    config.identifierKey,
    config.cloudConfig,
    adapter,
    userManager,
    referenceManager,
    scheduler
  );
  const resolved = resolveGanonConfig(config);
  const metadataStore = new MetadataStore<Ef4Storage>(storage);
  const coordinatorRepo = new MetadataCoordinatorRepo(
    config.cloudConfig,
    adapter,
    referenceManager,
    metadataStore,
    userManager,
    resolved,
    scheduler
  );
  const metadataManager = new MetadataManager(
    config,
    coordinatorRepo,
    metadataStore,
    new KeyRouter(config.cloudConfig)
  );
  const chunkManager = new ChunkManager(adapter, undefined, scheduler);
  return { adapter, firestoreManager, metadataManager, chunkManager, fake };
}

async function backup(
  firestoreManager: FirestoreManager<Ef4Storage>,
  value: unknown,
  version: number
) {
  await firestoreManager.backup('listKey', value, {
    digest: computeHash(value),
    version,
    session,
  });
}

async function fetchWithHydratedKind(
  metadataManager: MetadataManager<Ef4Storage>,
  firestoreManager: FirestoreManager<Ef4Storage>
) {
  await metadataManager.hydrateMetadata(session);
  const remote = metadataManager.getRemoteMetaForKey('listKey');
  return firestoreManager.fetch('listKey', { kindHint: remote?.k });
}

describe('E-F4: digestMap kind and chunk reconstruction', () => {
  it('writes k on digestMap for subcollection backup', async () => {
    const fake = new FakeFirestore();
    const { firestoreManager } = createHarness(fake);
    await backup(firestoreManager, ['a', 'b'], 1);
    const profile = fake.getDocument(PROFILE_PATH)!;
    expect((profile[DIGEST_MAP_KEY] as Record<string, unknown>).listKey).toEqual({
      d: computeHash(['a', 'b']),
      v: 1,
      k: 'array',
    });
  });

  it('round-trips [] and {} via kindHint from hydrated metadata', async () => {
    const fake = new FakeFirestore();
    const { firestoreManager, metadataManager } = createHarness(fake);
    await backup(firestoreManager, [], 1);
    expect(await fetchWithHydratedKind(metadataManager, firestoreManager)).toEqual([]);

    await backup(firestoreManager, {}, 2);
    expect(await fetchWithHydratedKind(metadataManager, firestoreManager)).toEqual({});
  });

  it('round-trips [a,b] and numeric-key object with correct kinds', async () => {
    const fake = new FakeFirestore();
    const { firestoreManager, metadataManager } = createHarness(fake);
    await backup(firestoreManager, ['a', 'b'], 1);
    expect(await fetchWithHydratedKind(metadataManager, firestoreManager)).toEqual(['a', 'b']);

    const numericObject = { '0': 'x', '1': 'y' };
    await backup(firestoreManager, numericObject, 2);
    expect(await fetchWithHydratedKind(metadataManager, firestoreManager)).toEqual(numericObject);
  });

  it('legacy doc without k uses numeric heuristic (array)', async () => {
    const fake = new FakeFirestore();
    const { firestoreManager } = createHarness(fake);
    fake.setDocument(`${COLL_PATH}/chunk_0`, { '0': 'legacy', '1': 'row' });
    expect(await firestoreManager.fetch('listKey')).toEqual(['legacy', 'row']);
  });

  it('6.3-shaped read ignores k and uses heuristic on new-client [a,b] storage', async () => {
    const fake = new FakeFirestore();
    const { firestoreManager, chunkManager } = createHarness(fake);
    await backup(firestoreManager, ['a', 'b'], 1);

    const collectionRef = fake.collection(PROFILE_PATH, 'listKey');
    const snapshot = await fake.getDocs(collectionRef as never);
    expect(reconstructChunkedData(snapshot)).toEqual(['a', 'b']);
    expect(await chunkManager.readData(collectionRef as any)).toEqual(['a', 'b']);
  });
});
