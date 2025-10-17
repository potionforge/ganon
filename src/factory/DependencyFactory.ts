import FirestoreAdapter from "../firestore/FirestoreAdapter";
import FirestoreManager from "../firestore/FirestoreManager";
import FirestoreReferenceManager from "../firestore/ref/FirestoreReferenceManager";
import StorageManager from "../managers/StorageManager";
import UserManager from "../managers/UserManager";
import LocalMetadataManager from "../metadata/local/LocalMetadataManager";
import MetadataCoordinatorRepo from "../metadata/MetadataCoordinatorRepo";
import MetadataManager from "../metadata/MetadataManager";
import { GanonConfig } from "../models/config/GanonConfig";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import OperationRepo from "../sync/OperationRepo";
import SyncController from "../sync/SyncController";
import NetworkMonitor from "../utils/NetworkMonitor";

export default class DependencyFactory<T extends BaseStorageMapping> {
  private storageManager: StorageManager<T>;
  private firestoreManager: FirestoreManager<T>;
  private localMetadataManager: LocalMetadataManager<T>;
  private networkMonitor: NetworkMonitor;
  private operationRepo: OperationRepo<T>;
  private syncController: SyncController<T>;
  private firestoreAdapter: FirestoreAdapter<T>;
  private referenceManager: FirestoreReferenceManager<T>;
  private metadataCacheController: MetadataCoordinatorRepo<T>;
  private metadataManager: MetadataManager<T>;
  private userManager: UserManager<T>;

  constructor(config: GanonConfig<T>) {
    try {
      this.storageManager = new StorageManager<T>();
      this.userManager = new UserManager<T>(config.identifierKey, this.storageManager);
      this.firestoreAdapter = new FirestoreAdapter<T>(config);
      this.firestoreManager = new FirestoreManager<T>(
        config.identifierKey,
        config.cloudConfig,
        this.firestoreAdapter,
        this.userManager
      );
      this.localMetadataManager = new LocalMetadataManager<T>(this.storageManager);
      this.networkMonitor = new NetworkMonitor();
      this.referenceManager = new FirestoreReferenceManager<T>(
        this.userManager,
        config.cloudConfig,
      );
      this.metadataCacheController = new MetadataCoordinatorRepo<T>(
        config.cloudConfig,
        this.firestoreAdapter,
        this.referenceManager,
        this.localMetadataManager,
        this.userManager
      );
      this.metadataManager = new MetadataManager<T>(
        config,
        this.metadataCacheController,
        this.localMetadataManager,
      );
      this.operationRepo = new OperationRepo<T>(
        this.networkMonitor,
        {
          storage: this.storageManager,
          firestore: this.firestoreManager,
          metadataManager: this.metadataManager,
        }
      );
      this.syncController = new SyncController<T>(
        this.storageManager,
        this.firestoreManager,
        this.metadataManager,
        this.operationRepo,
        this.userManager,
        config
      );
    } catch (error) {
      throw new Error(`Failed to initialize components: ${error}`);
    }
  }

  getDependencies(): {
    storageManager: StorageManager<T>;
    firestoreManager: FirestoreManager<T>;
    localMetadataManager: LocalMetadataManager<T>;
    networkMonitor: NetworkMonitor;
    operationRepo: OperationRepo<T>;
    syncController: SyncController<T>;
    firestoreAdapter: FirestoreAdapter<T>;
    referenceManager: FirestoreReferenceManager<T>;
    cacheController: MetadataCoordinatorRepo<T>;
    metadataManager: MetadataManager<T>;
    userManager: UserManager<T>;
  } {
    return {
      storageManager: this.storageManager,
      firestoreManager: this.firestoreManager,
      localMetadataManager: this.localMetadataManager,
      networkMonitor: this.networkMonitor,
      operationRepo: this.operationRepo,
      syncController: this.syncController,
      firestoreAdapter: this.firestoreAdapter,
      referenceManager: this.referenceManager,
      cacheController: this.metadataCacheController,
      metadataManager: this.metadataManager,
      userManager: this.userManager,
    };
  }
}