import FirestoreAdapter from "../firestore/FirestoreAdapter";
import FirestoreManager from "../firestore/FirestoreManager";
import FirestoreReferenceManager from "../firestore/ref/FirestoreReferenceManager";
import StorageManager from "../managers/StorageManager";
import UserManager from "../managers/UserManager";
import LocalMetadataManager from "../metadata/local/LocalMetadataManager";
import MetadataStore from "../metadata/local/MetadataStore";
import MetadataCoordinatorRepo from "../metadata/MetadataCoordinatorRepo";
import MetadataManager from "../metadata/MetadataManager";
import { InternalGanonConfig } from "../models/config/GanonConfig";
import { resolveGanonConfig } from "../models/config/resolveGanonConfig";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import OperationRepo from "../sync/OperationRepo";
import SyncEngine from "../sync/SyncEngine";
import NetworkMonitor from "../utils/NetworkMonitor";
import { SystemClock } from "../ports/Clock";
import { SystemScheduler } from "../ports/Scheduler";
import { MMKV } from "react-native-mmkv";
import { KeyValueStore } from "../ports/KeyValueStore";
import { FirebaseFirestoreTypes, getFirestore } from '@react-native-firebase/firestore';
import KeyRouter from "../routing/KeyRouter";

export default class DependencyFactory<T extends BaseStorageMapping> {
  private storageManager: StorageManager<T>;
  private firestoreManager: FirestoreManager<T>;
  private metadataStore: MetadataStore<T>;
  private networkMonitor: NetworkMonitor;
  private operationRepo: OperationRepo<T>;
  private syncEngine: SyncEngine<T>;
  private firestoreAdapter: FirestoreAdapter<T>;
  private referenceManager: FirestoreReferenceManager<T>;
  private metadataCacheController: MetadataCoordinatorRepo<T>;
  private metadataManager: MetadataManager<T>;
  private userManager: UserManager<T>;
  private keyRouter: KeyRouter<T>;

  constructor(config: InternalGanonConfig<T>) {
    try {
      const clock = new SystemClock();
      const scheduler = new SystemScheduler();
      const storageKv: KeyValueStore = new MMKV();
      const operationsKv: KeyValueStore = new MMKV({ id: 'ganon_operations' });
      const firestoreModule = getFirestore();
      const resolvedConfig = resolveGanonConfig(config);
      this.keyRouter = new KeyRouter<T>(config.cloudConfig);

      this.storageManager = new StorageManager<T>(storageKv);
      this.userManager = new UserManager<T>(config.identifierKey, this.storageManager);
      this.firestoreAdapter = new FirestoreAdapter<T>(config, firestoreModule);
      this.referenceManager = new FirestoreReferenceManager<T>(
        this.userManager,
        config.cloudConfig,
        this.keyRouter,
        firestoreModule
      );
      this.firestoreManager = new FirestoreManager<T>(
        config.identifierKey,
        config.cloudConfig,
        this.firestoreAdapter,
        this.userManager,
        this.referenceManager,
        scheduler
      );
      this.metadataStore = new MetadataStore<T>(this.storageManager);
      this.networkMonitor = new NetworkMonitor();
      this.metadataCacheController = new MetadataCoordinatorRepo<T>(
        config.cloudConfig,
        this.firestoreAdapter,
        this.referenceManager,
        this.metadataStore,
        this.userManager,
        resolvedConfig,
        scheduler
      );
      this.metadataManager = new MetadataManager<T>(
        config,
        this.metadataCacheController,
        this.metadataStore,
        this.keyRouter,
      );
      this.operationRepo = new OperationRepo<T>(
        this.networkMonitor,
        {
          storage: this.storageManager,
          firestore: this.firestoreManager,
          metadataManager: this.metadataManager,
        },
        operationsKv
      );
      this.syncEngine = new SyncEngine<T>(
        this.storageManager,
        this.firestoreManager,
        this.metadataManager,
        this.operationRepo,
        this.userManager,
        config,
        clock,
        scheduler,
        this.keyRouter
      );
    } catch (error) {
      throw new Error(`Failed to initialize components: ${error}`);
    }
  }

  getDependencies(): {
    storageManager: StorageManager<T>;
    firestoreManager: FirestoreManager<T>;
    metadataStore: MetadataStore<T>;
    localMetadataManager: MetadataStore<T>;
    networkMonitor: NetworkMonitor;
    operationRepo: OperationRepo<T>;
    syncEngine: SyncEngine<T>;
    firestoreAdapter: FirestoreAdapter<T>;
    referenceManager: FirestoreReferenceManager<T>;
    cacheController: MetadataCoordinatorRepo<T>;
    metadataManager: MetadataManager<T>;
    userManager: UserManager<T>;
    keyRouter: KeyRouter<T>;
  } {
    return {
      storageManager: this.storageManager,
      firestoreManager: this.firestoreManager,
      metadataStore: this.metadataStore,
      localMetadataManager: this.metadataStore,
      networkMonitor: this.networkMonitor,
      operationRepo: this.operationRepo,
      syncEngine: this.syncEngine,
      firestoreAdapter: this.firestoreAdapter,
      referenceManager: this.referenceManager,
      cacheController: this.metadataCacheController,
      metadataManager: this.metadataManager,
      userManager: this.userManager,
      keyRouter: this.keyRouter,
    };
  }
}