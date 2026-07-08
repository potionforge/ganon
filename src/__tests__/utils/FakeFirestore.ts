// Type-only imports from @react-native-firebase/firestore only; runtime imports create a cycle with the manual mock.
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import { deepMerge } from './deepMerge';

type DocData = Record<string, unknown>;

export function getFakeFromModule(module: unknown): FakeFirestore | undefined {
  if (typeof module === 'object' && module !== null && '__fakeFirestore' in module) {
    return (module as { __fakeFirestore: FakeFirestore }).__fakeFirestore;
  }
  return undefined;
}

export function getRefOwner(ref: unknown): FakeFirestore | undefined {
  if (typeof ref === 'object' && ref !== null && '__owner' in ref) {
    return (ref as { __owner: FakeFirestore }).__owner;
  }
  return undefined;
}

export class FakeDocRef implements FirebaseFirestoreTypes.DocumentReference {
  constructor(
    public path: string,
    readonly __owner: FakeFirestore
  ) {}
  get id(): string {
    return this.path.split('/').pop() || '';
  }
  get parent(): FirebaseFirestoreTypes.CollectionReference {
    const parts = this.path.split('/');
    parts.pop();
    return new FakeColRef(parts.join('/'), this.__owner);
  }
  collection = (id: string) => new FakeColRef(`${this.path}/${id}`, this.__owner);
  isEqual = (other: FirebaseFirestoreTypes.DocumentReference) => other.path === this.path;
}

export class FakeColRef implements FirebaseFirestoreTypes.CollectionReference {
  constructor(
    public path: string,
    readonly __owner: FakeFirestore
  ) {}
  get id(): string {
    return this.path.split('/').pop() || '';
  }
  get parent(): FirebaseFirestoreTypes.DocumentReference | null {
    if (!this.path.includes('/')) return null;
    const parts = this.path.split('/');
    parts.pop();
    return new FakeDocRef(parts.join('/'), this.__owner);
  }
  doc = (id: string) => new FakeDocRef(`${this.path}/${id}`, this.__owner);
  isEqual = (other: FirebaseFirestoreTypes.CollectionReference) => other.path === this.path;
}

/**
 * In-memory Firestore test double with merge semantics, transactions, and batches.
 * Tracks query reads (getDoc/getDocs calls, not per-document) for N-fetch regression tests.
 */
export class FakeFirestore {
  private documents = new Map<string, DocData>();
  readonly module = { __fakeFirestore: this } as FirebaseFirestoreTypes.Module;
  private readCount = 0;

  doc(
    parent: FirebaseFirestoreTypes.DocumentReference | FirebaseFirestoreTypes.CollectionReference | FirebaseFirestoreTypes.Module | string,
    ...pathSegments: string[]
  ): FakeDocRef {
    const segments =
      typeof parent === 'string'
        ? [parent, ...pathSegments]
        : 'path' in parent
          ? [parent.path, ...pathSegments]
          : pathSegments;
    return new FakeDocRef(segments.filter(Boolean).join('/'), this);
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
    return new FakeColRef([base, ...pathSegments].filter(Boolean).join('/'), this);
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
        const docRef = new FakeDocRef(path, this);
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
    let hasWrites = false;
    const tx = {
      get: (ref: FirebaseFirestoreTypes.DocumentReference) => {
        if (hasWrites) {
          throw new Error('Firestore transactions disallow reading after writing');
        }
        return this.getDoc(ref);
      },
      set: (ref: FirebaseFirestoreTypes.DocumentReference, data: DocData, options?: FirebaseFirestoreTypes.SetOptions) => {
        hasWrites = true;
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
        hasWrites = true;
        pending.push(() => {
          const existing = this.documents.get(ref.path) || {};
          this.documents.set(ref.path, deepMerge(existing, data));
        });
      },
      delete: (ref: FirebaseFirestoreTypes.DocumentReference) => {
        hasWrites = true;
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
