import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';

type DocData = Record<string, unknown>;

class FakeDocRef implements FirebaseFirestoreTypes.DocumentReference {
  constructor(public path: string) {}
  get id(): string {
    return this.path.split('/').pop() || '';
  }
  get parent(): FirebaseFirestoreTypes.CollectionReference {
    const parts = this.path.split('/');
    parts.pop();
    return new FakeColRef(parts.join('/'));
  }
  collection = (id: string) => new FakeColRef(`${this.path}/${id}`);
  isEqual = (other: FirebaseFirestoreTypes.DocumentReference) => other.path === this.path;
}

class FakeColRef implements FirebaseFirestoreTypes.CollectionReference {
  constructor(public path: string) {}
  get id(): string {
    return this.path.split('/').pop() || '';
  }
  get parent(): FirebaseFirestoreTypes.DocumentReference | null {
    if (!this.path.includes('/')) return null;
    const parts = this.path.split('/');
    parts.pop();
    return new FakeDocRef(parts.join('/'));
  }
  doc = (id: string) => new FakeDocRef(`${this.path}/${id}`);
  isEqual = (other: FirebaseFirestoreTypes.CollectionReference) => other.path === this.path;
}

function deepMerge(target: DocData, source: DocData): DocData {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as DocData, value as DocData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * In-memory Firestore test double with merge semantics, transactions, and batches.
 * Tracks document reads for N-fetch regression tests.
 */
export class FakeFirestore {
  private documents = new Map<string, DocData>();
  readonly module = { __fakeFirestore: this } as FirebaseFirestoreTypes.Module;
  private readCount = 0;

  doc(_firestore: FirebaseFirestoreTypes.Module, ...pathSegments: string[]): FakeDocRef {
    return new FakeDocRef(pathSegments.join('/'));
  }

  collection(
    parent: FirebaseFirestoreTypes.DocumentReference | FirebaseFirestoreTypes.Module | string,
    ...pathSegments: string[]
  ): FakeColRef {
    const base =
      typeof parent === 'string'
        ? parent
        : 'path' in parent
          ? parent.path
          : '';
    return new FakeColRef([base, ...pathSegments].filter(Boolean).join('/'));
  }

  async getDoc(ref: FirebaseFirestoreTypes.DocumentReference): Promise<FirebaseFirestoreTypes.DocumentSnapshot> {
    this.readCount++;
    const data = this.documents.get(ref.path);
    return {
      exists: data !== undefined,
      data: () => data,
      id: ref.id,
      ref,
      metadata: { fromCache: false, hasPendingWrites: false },
      get: (field: string) => data?.[field],
      isEqual: (other: FirebaseFirestoreTypes.DocumentSnapshot) => other.ref.path === ref.path,
    } as FirebaseFirestoreTypes.DocumentSnapshot;
  }

  async getDocs(ref: FirebaseFirestoreTypes.CollectionReference): Promise<FirebaseFirestoreTypes.QuerySnapshot> {
    this.readCount++;
    const prefix = ref.path + '/';
    const docs: FirebaseFirestoreTypes.DocumentSnapshot[] = [];
    for (const [path, data] of this.documents.entries()) {
      if (path.startsWith(prefix) && path.slice(prefix.length).indexOf('/') === -1) {
        const docRef = new FakeDocRef(path);
        docs.push({
          exists: true,
          data: () => data,
          id: docRef.id,
          ref: docRef,
          metadata: { fromCache: false, hasPendingWrites: false },
          get: (field: string) => data[field],
          isEqual: () => false,
        } as FirebaseFirestoreTypes.DocumentSnapshot);
      }
    }
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      metadata: { fromCache: false, hasPendingWrites: false },
      forEach: (cb: (doc: FirebaseFirestoreTypes.DocumentSnapshot) => void) => docs.forEach(cb),
    } as FirebaseFirestoreTypes.QuerySnapshot;
  }

  async setDoc(
    ref: FirebaseFirestoreTypes.DocumentReference,
    data: DocData,
    options?: FirebaseFirestoreTypes.SetOptions
  ): Promise<void> {
    if (options?.merge) {
      const existing = this.documents.get(ref.path) || {};
      this.documents.set(ref.path, deepMerge(existing, data));
    } else {
      this.documents.set(ref.path, { ...data });
    }
  }

  async updateDoc(ref: FirebaseFirestoreTypes.DocumentReference, data: DocData): Promise<void> {
    const existing = this.documents.get(ref.path) || {};
    this.documents.set(ref.path, deepMerge(existing, data));
  }

  async deleteDoc(ref: FirebaseFirestoreTypes.DocumentReference): Promise<void> {
    this.documents.delete(ref.path);
  }

  async runTransaction<T>(
    updateFunction: (transaction: FirebaseFirestoreTypes.Transaction) => Promise<T>
  ): Promise<T> {
    const pending: Array<() => void> = [];
    const tx = {
      get: (ref: FirebaseFirestoreTypes.DocumentReference) => this.getDoc(ref),
      set: (ref: FirebaseFirestoreTypes.DocumentReference, data: DocData, options?: FirebaseFirestoreTypes.SetOptions) => {
        pending.push(() => {
          if (options?.merge) {
            const existing = this.documents.get(ref.path) || {};
            this.documents.set(ref.path, deepMerge(existing, data));
          } else {
            this.documents.set(ref.path, { ...data });
          }
        });
      },
      update: (ref: FirebaseFirestoreTypes.DocumentReference, data: DocData) => {
        pending.push(() => {
          const existing = this.documents.get(ref.path) || {};
          this.documents.set(ref.path, deepMerge(existing, data));
        });
      },
      delete: (ref: FirebaseFirestoreTypes.DocumentReference) => {
        pending.push(() => this.documents.delete(ref.path));
      },
    } as FirebaseFirestoreTypes.Transaction;

    const result = await updateFunction(tx);
    pending.forEach(op => op());
    return result;
  }

  writeBatch(): FirebaseFirestoreTypes.WriteBatch {
    const pending: Array<() => void> = [];
    const batch = {
      set: (ref: FirebaseFirestoreTypes.DocumentReference, data: DocData, options?: FirebaseFirestoreTypes.SetOptions) => {
        pending.push(() => {
          if (options?.merge) {
            const existing = this.documents.get(ref.path) || {};
            this.documents.set(ref.path, deepMerge(existing, data));
          } else {
            this.documents.set(ref.path, { ...data });
          }
        });
        return batch;
      },
      update: (ref: FirebaseFirestoreTypes.DocumentReference, data: DocData) => {
        pending.push(() => {
          const existing = this.documents.get(ref.path) || {};
          this.documents.set(ref.path, deepMerge(existing, data));
        });
        return batch;
      },
      delete: (ref: FirebaseFirestoreTypes.DocumentReference) => {
        pending.push(() => this.documents.delete(ref.path));
        return batch;
      },
      commit: async () => {
        pending.forEach(op => op());
      },
    } as FirebaseFirestoreTypes.WriteBatch;
    return batch;
  }

  getReadCount(): number {
    return this.readCount;
  }

  resetReadCount(): void {
    this.readCount = 0;
  }

  getDocument(path: string): DocData | undefined {
    return this.documents.get(path);
  }

  setDocument(path: string, data: DocData): void {
    this.documents.set(path, data);
  }

  clear(): void {
    this.documents.clear();
    this.readCount = 0;
  }
}
