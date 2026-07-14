# Ganon Architecture Proposal — Revised (v2.5)

**Status:** Replaces `ARCHITECTURE_PROPOSAL.md` (referred to below as "the old proposal").
**Grounding:** Every claim below was verified against the current source of `@potionforge/ganon`
(`src/`, ~8,200 lines) as of July 2026. Where production usage validates an invariant or
extension point, a production consumer is cited as *evidence only* — not as a dependency of
this plan. LetThemGo-specific rollout, gates, and adoption work live in `LTG_ADOPTION.md`.

**Revision history:** v2.1 — step 6 version-based read, chunked atomicity bounds,
login-cycle APIs, §8 gates. v2.2 — §8 decisions recorded (Q1–Q6); step 6 tie-break +
measurable rollout gate; steps 4–5 and 8 unblocked. v2.3 — Q5 stash-merge contract;
step 6 sub-step 2 acceptance criteria + kill-switch. v2.4 — consumer separation; adoption
content extracted to `LTG_ADOPTION.md`. v2.5 — step 7 vocabulary constraint; multi-backend
deferral recorded in §7.

---

## 1. Drift Report

Claims in the old proposal that no longer match (or never matched) the code.

### D1. The hierarchy diagram describes a fraction of the system
Old proposal lines 11–23 present `DependencyFactory → SyncController → MetadataManager →
MetadataCoordinatorRepo → MetadataCoordinator → LocalMetadataManager` as *the* architecture.
`DependencyFactory` (`src/factory/DependencyFactory.ts:28-76`) actually wires **eleven**
components. The proposal is silent on:

- `StorageManager` (MMKV + LRU cache, `src/managers/StorageManager.ts`)
- `OperationRepo` + `SetOperation`/`DeleteOperation` — a *persistent, retrying* operation queue
  backed by its own MMKV instance (`src/sync/OperationRepo.ts:47`, `:105-118`)
- `FirestoreManager` / `FirestoreAdapter` / `FirestoreReferenceManager` / `DataProcessor` /
  `ChunkManager` — ~2,400 lines, the largest subsystem
- `ConflictResolver`, the integrity-failure recovery machinery
  (`src/sync/SyncController.ts:937-1213`), `UserManager`, `NetworkMonitor`
- `LocalGanon`, the event system (`on`/`off`/`once`), and the `login()`/`logout()` lifecycle
  (`src/Ganon.ts:355-416`) — all added after the proposal was written

Any redesign scoped only to the metadata slice (~750 lines) misses where most complexity and
most bugs live.

### D2. "Circular dependency pattern" — there is no cycle
Old proposal line 37 claims `MetadataManager → MetadataCoordinator → LocalMetadataManager` is
circular. It is a **diamond**, not a cycle: `MetadataManager` holds `LocalMetadataManager`
directly (`src/metadata/MetadataManager.ts:17`) *and* every `MetadataCoordinator` holds the same
`LocalMetadataManager` instance (`src/metadata/remote/MetadataCoordinator.ts:55`). The real
problem is **two writers to one store through two paths** (reads go via the manager, writes go
via the coordinator), which makes the write path hard to reason about — but that is a different
problem with a different fix than "break the cycle."

### D3. "IMetadataBase doesn't match implementations" — stale diagnosis
`LocalMetadataManager` *does* implement `IMetadataBase`
(`src/metadata/local/LocalMetadataManager.ts:10`); the covariant return
(`LocalSyncMetadata extends SyncMetadata`) is legal. The actual interface rot today is
different and worse:

- The interfaces are **decorative**. `SyncController`'s constructor takes the concrete
  `StorageManager`, `FirestoreManager`, `MetadataManager`, `OperationRepo`, `UserManager`
  (`src/sync/SyncController.ts:50-57`). Nothing consumes `IStorageManager` or `IMetadataBase`
  as a dependency type, so tests fake components with unsound casts
  (`src/__tests__/utils/TestSetupUtils.ts:33`, `as unknown as jest.Mocked<...>`).
- `IStorageManager.upsert` declares `data: T[K]` (`src/models/interfaces/IStorageManager.ts:7`)
  while the implementation takes `Partial<T[K]>` (`src/managers/StorageManager.ts:62`).
- `IMetadataBase.get` is typed to return metadata unconditionally — and that is **load-bearing,
  not a bug**: `LocalMetadataManager.get` never returns `undefined`; it synthesizes
  `{digest: '', version: 0, syncStatus: Synced}` on a miss *without persisting it*
  (`src/metadata/local/LocalMetadataManager.ts:18-31`). `needsHydration` (`remote.v > local.version`
  where missing-local means `0`, `src/metadata/remote/MetadataCoordinator.ts:79-82`) and
  `markAsDeleted` (skips when `digest === ''`, `src/sync/SyncController.ts:266-271`) both depend
  on this default. The old proposal's replacement signature
  `get(key): Promise<LocalSyncMetadata | undefined>` (line 84) would silently break both.

### D4. "Add missing async operations to interfaces" — now actively wrong
Old proposal lines 43 and 83–90 propose making local metadata operations async. Since then the
synchronous read path has become the product's core contract: consumers read Ganon synchronously
at render time and in migrations everywhere (production evidence: consumer migration manager
reading `lastRunMigration` via `ganon.get` — `LTG_ADOPTION.md`). MMKV is synchronous by design.
Async-ifying the local layer would force an `await` ripple through `Ganon.get` and a rewrite of
consumers. **Local = sync, remote = async** is a boundary to *preserve*, not erase.

### D5. The Command pattern phase is superseded by shipped code
Old proposal lines 126–183 propose `IMetadataCommand`, `UpdateMetadataCommand`, and a
`MetadataCommandExecutor` with undo history. The codebase now contains
`BaseSyncOperation`/`SetOperation`/`DeleteOperation` with retry counting and
serialize/deserialize (`src/sync/operations/BaseSyncOperation.ts:22-59`), plus `OperationRepo`,
which persists pending operations across app restarts to a dedicated MMKV instance and processes
them in batches with retry/backoff (`src/sync/OperationRepo.ts:37-258`). This is the command
pattern minus `undo()` — and nothing in the product needs undo. The remaining gap is
testability of the queue (hard-wired `new MMKV(...)`), not a missing pattern.

### D6. "Repository pattern" phase — the seam already exists, one layer down
Old proposal lines 186–214 propose `IMetadataRepository` + `FirestoreMetadataRepository`. The
current code already funnels every Firestore I/O through `FirestoreAdapter`
(`src/firestore/FirestoreAdapter.ts`), which has an interface (`IFirestoreAdapter`) and is the
single place `remoteReadonly` is enforced. The problem is not a missing repository; it is that
the adapter and reference manager **construct their own Firestore handle**
(`FirestoreAdapter.ts:18`, `FirestoreReferenceManager.ts:17` — both call `getFirestore()` at
field-init), and `FirestoreManager` builds a *second* `FirestoreReferenceManager* while
`DependencyFactory` builds another (`src/firestore/FirestoreManager.ts:39` vs
`src/factory/DependencyFactory.ts:41-44`). Adding a repository on top of an untestable adapter
adds indirection without adding testability.

### D7. "Configuration scattered" — confirmed, with a sharper example than the proposal had
`MetadataCoordinator` carries a **private hardcoded config** — 5-minute TTL, batch size, and
notably its own `conflictResolutionStrategy: LAST_MODIFIED_WINS`
(`src/metadata/remote/MetadataCoordinator.ts:41-46`) — that ignores
`GanonConfig.conflictResolutionConfig` entirely. So a consumer who configures `LOCAL_WINS` gets
it for *data* conflicts but silently not for *metadata* conflicts. `ChunkManager` similarly
hardcodes TTLs, batch sizes, and lock timeouts (`src/firestore/chunking/ChunkManager.ts:18-23`).
The old proposal's claim survives; its evidence was stale.

### D8. What the proposal never saw: the data/digest atomicity gap is the root cause
The old proposal treats "conflict resolution" and "cache invalidation" as coordinator
responsibilities to shuffle around. The code reveals the actual disease: **a value and its
digest travel to Firestore on two unsynchronized paths.** `SetOperation` writes the value inside
a transaction (`src/sync/operations/SetOperation.ts:31-53`; the comment at `:45-46` admits "the
metadata update happens outside the transaction"), while the digest reaches the remote
`remote_metadata` map via a *debounced, ~1s-later* coordinator flush
(`src/metadata/remote/MetadataCoordinator.ts:118-139`, `:356-373`). Every window between the two
writes is a window where hydration on another device computes a digest mismatch. The entire
integrity-failure apparatus — retry loops, four recovery strategies, per-invocation configs
(`src/sync/SyncController.ts:477-513`, `:937-976`, `:1106-1213`, ~350 lines) — exists to
compensate for this non-atomicity. No amount of coordinator re-layering fixes it; the write
protocol does.

### D9. Smaller factual drift
- "MetadataCoordinatorRepo (Factory)" (line 18): it is a registry keyed by *document name* built
  once from `cloudConfig` (`src/metadata/MetadataCoordinatorRepo.ts:23-38`), not a factory.
- `computeHash` docstring says 32-char hash; implementation truncates to 16
  (`src/utils/computeHash.ts:59`).
- Key-to-document routing is duplicated **three** times, not centralized anywhere the proposal
  mentions: `Ganon._shouldSyncKey` (`src/Ganon.ts:508-513`), `MetadataManager`'s
  `keyToDocumentMap` (`src/metadata/MetadataManager.ts:179-213`), and
  `FirestoreReferenceManager._processByKey` (`src/firestore/ref/FirestoreReferenceManager.ts:148-163`).
- `restore()` writes fetched values to storage but never updates local metadata digests
  (`src/sync/SyncController.ts:377-386`), so the next `syncAll()` sees hash mismatches on every
  restored key and re-uploads all of them. **Resolved (§8 Q2):** bug — step 5 ships; restore
  should leave the device `Synced`.

---

## 2. Invariant Inventory

Correctness invariants extracted from code. **Enforcement:** *structural* = the code makes
violation hard; *convention* = a comment, a default, or discipline is all that protects it.
Convention-enforced invariants are the highest-value redesign targets.

| # | Invariant | Where enforced today | How |
|---|---|---|---|
| **I1** | Reads of missing keys return in-memory defaults **without persisting** (no eager writes). A write of a default before cloud hydrate syncs the default and clobbers remote data. | **Library:** `StorageManager.get` returns `undefined`, touches only the in-memory LRU (`src/managers/StorageManager.ts:16-36`). `LocalMetadataManager.get` synthesizes a default without writing (`src/metadata/local/LocalMetadataManager.ts:18-31`). **Consumer-side evidence:** get-or-default manager pattern with per-manager regression tests (`LTG_ADOPTION.md`). | **Convention** — library API shape helps but does not enforce; consumers uphold via discipline + tests. Step 8 adds `getOrDefault` and `earlyWriteGuard` as structural aids. |
| **I2** | Absence ≠ false. (a) Metadata tombstone: `digest === ''` means "never synced / nothing remote" — `markAsDeleted` skips the remote delete when digest is empty (`src/sync/SyncController.ts:266-271`); `DeleteOperation` leaves `{digest:'', version, status:Synced}` as the tombstone (`src/sync/operations/DeleteOperation.ts:32-36`). (b) Remote-metadata absence: `remote[key]?.v > local.version` → absent remote = no hydration (`src/metadata/remote/MetadataCoordinator.ts:79-82`). (c) App hashmap buckets: consumer may store only positive sentinels; absence means false — **consumer-side evidence** in `LTG_ADOPTION.md`. | See left. | **Convention** — `''` is a string sentinel with no type-level distinction; one `metadata.digest = ''` written by mistake silently converts "synced" into "never existed." |
| **I3** | Metadata writes during hydration must **never** schedule a remote metadata sync (or hydration echoes remote state back to the server as if it were a local edit). | Five call sites pass `scheduleRemoteSync = false` with the same comment (`src/sync/SyncController.ts:466, :522, :669, :1037, :1201`). | **Convention** — the parameter *defaults to `true`* (`src/metadata/MetadataManager.ts:48`), so the dangerous behavior is the default and safety requires remembering an argument. |
| **I4** | A value in Firestore and its digest in `remote_metadata` must agree. | Not enforced on the write path at all (see D8). Enforced *reactively* on the read path by integrity retry + recovery strategies (`src/sync/SyncController.ts:477-513`). | **Convention/compensation** — the single most expensive invariant in the codebase. |
| **I5** | Migrations are idempotent and monotonic. | **Consumer-side:** cursor key (often cloud-synced via `cloudConfig`) with skip-if-already-run; per-migration idempotency is each migration body's responsibility. Lexicographic vs semver ordering is a consumer hazard — see `LTG_ADOPTION.md`. | **Convention** — Ganon provides sync for cursor keys; ordering semantics are the consumer's. |
| **I6** | Generation-guard: cache/server writes complete unconditionally; only UI/async follow-up work is guarded by a generation check. | **Consumer-side evidence:** production pattern where cache persistence is unconditional but React `setState` is generation-guarded (`LTG_ADOPTION.md`). **Library analogs:** hydration promise dedupe (`src/sync/SyncController.ts:411-414`), `syncInProgress` flag (`:167-179`). | **Convention** app-side. Ganon offers `whenHydrated()` (step 8) and `hydrationComplete`; generation guards remain consumer-owned. |
| **I7** | `version` is a wall-clock `Date.now()` timestamp used as the logical clock for hydration ordering and `LAST_MODIFIED_WINS` (`src/sync/SyncController.ts:237`, `src/sync/operations/SetOperation.ts:50`, `src/sync/ConflictResolver.ts:70-77`, `src/metadata/remote/MetadataCoordinator.ts:348-352`). | Everywhere, uniformly. | **Convention** — clock-skew-fragile. **Resolved (§8 Q1):** adopt `max(Date.now(), lastKnownVersion + 1)` in step 4. |
| **I8** | Only keys listed in `cloudConfig` ever sync, and only while a user is logged in. Local writes always succeed regardless of cloud state; sync failure only flips `syncStatus`. | `Ganon.set` gates on `_shouldSyncKey` + `isUserLoggedIn` (`src/Ganon.ts:129-138`, `:503-514`); every `FirestoreManager` op re-checks login; `SetOperation` failure path only sets `SyncStatus.Failed` (`src/sync/operations/SetOperation.ts:63-69`). | **Structural** (one of the few). Preserve it. |
| **I9** | Reserved keys don't collide with user keys: `'_sync_metadata_'` lives in the *same* MMKV namespace as user data (`src/constants.ts:4`, `src/metadata/local/LocalMetadataManager.ts:90-96`); pending operations live in a separate instance `'ganon_operations'` (`src/sync/OperationRepo.ts:15,47`). | Nothing validates that a consumer's `StorageMapping` doesn't declare `_sync_metadata_`. | **Convention.** |

---

## 3. Section-by-Section Verdict on the Old Proposal

| Old section | Verdict | Justification |
|---|---|---|
| **Current issue 1: SRP violation in MetadataCoordinator** (l. 27-34) | **KEEP** | Still accurate. The class is 402 lines doing remote caching, TTL policy, flush debouncing, metadata conflict resolution, *and* local writes (`MetadataCoordinator.ts:118-139` writes local then schedules remote). The split proposed in §4 addresses it. |
| **Current issue 2: tight coupling / "circular dependency"** (l. 36-39) | **REVISE** | No cycle exists (D2). The real coupling problem: dependencies are concrete classes end-to-end, so tests use unsound casts and no component can be faked through its type (D3). Fix is "consume interfaces at the three or four boundaries that tests actually need," not "break cycles." |
| **Current issue 3: inconsistent interface contracts** (l. 41-44) | **REVISE** | The named example is stale (D3) and the "add async" prescription is now harmful (D4). Keep the headline, replace the content: fix `IStorageManager.upsert`'s signature, make interfaces load-bearing, and *document* the never-undefined metadata default instead of "fixing" it. |
| **Current issue 4: configuration scattered** (l. 46-49) | **KEEP** | Better evidence now than when written: `MetadataCoordinator`'s private config silently ignores the user's conflict strategy (D7). Fix: one resolved-config object built at init, passed down, no layer-local defaults. |
| **Current issue 5: mixed concerns in coordinator** (l. 51-54) | **KEEP** | Same as issue 1; merged in §4. |
| **Clean Architecture 3-layer diagram** (l. 58-77) | **DROP** | Generic diagram with no mapping to actual modules. Replaced by the concrete seams in §4, which follow the layering *spirit* without introducing "Domain/Application/Infrastructure" vocabulary that matches nothing in the tree. |
| **`ILocalMetadataService`** (l. 81-91) | **REVISE** | Right idea (local metadata behind a small interface), two wrong details: all methods `Promise`-typed (D4), and `get` returning `undefined` (breaks I1/I2 consumers, D3). Adapted version in §4.3: synchronous, default-returning, tombstone-typed. |
| **`IRemoteMetadataService`** (l. 93-102) | **REVISE** | The five methods conflate two lifetimes: a read-side cache (`fetchMetadata`/`invalidateCache`) and a write-side flush queue (`scheduleSync`/`cancelPendingSync`). §4.3 splits them, which is also what makes I3 structurally enforceable. |
| **`IMetadataCoordinator` "pure coordination"** (l. 104-112) | **DROP** | A coordinator whose four methods are `coordinateX(...)` forwarding to services is pure indirection — the calling code (`SyncController`) is already the coordinator. After the §4.3 split, nothing is left for this class to do. |
| **`ICacheService<T>`** (l. 114-124) | **DROP** | Speculative generic. The two real caches have incompatible semantics: metadata cache is TTL + pending-key tracking; chunk cache is write-locked + version-stamped (`ChunkManager.ts:26-42`). One interface would be the union of both feature sets, used once each. |
| **Command pattern + executor** (l. 126-183) | **OBSOLETE** | Shipped in better form as `SetOperation`/`DeleteOperation`/`OperationRepo` with persistence and retries (D5). `undo()`/history is speculative — no product requirement. Remaining work is injecting the queue's MMKV handle (§6 step 1), not re-patterning. |
| **Repository pattern** (l. 186-214) | **DROP** (keep the goal) | The testability goal is real; the mechanism is wrong (D6). `FirestoreAdapter` is already the single choke point — make *it* injectable and provide an in-memory fake. An `IMetadataRepository` with one implementation forever fails the speculative-abstraction test. |
| **Phase 1: interface standardization** (l. 218-231) | **REVISE** | Still first, but redefined: make existing interfaces real at consumption sites; do **not** async-ify (D4). |
| **Phase 2: service separation** (l. 233-248) | **REVISE** | Direction correct; the extracted `CacheService` is dropped (above) and the split is driven by I3/I4 enforcement rather than by symmetry. |
| **Phase 3: repository** (l. 250-263) | **DROP** | See above. |
| **Phase 4: command pattern** (l. 265-278) | **OBSOLETE** | See above. |
| **Migration strategy: adapters, feature flags, rollback** (l. 280-296) | **REVISE** | "Each phase shippable" survives as a hard requirement (§6). Runtime feature flags + old/new dual implementations are overkill for a library on a `beta` version channel; revertibility comes from small PRs + the one dual-*write* step (§6 step 6), not runtime flags. Consumer rollout flags (e.g. `digestReadMode`) are wired by each app — see adoption plan. |
| **Benefits / risks / metrics** (l. 298-368) | **REVISE** | Generic but harmless. Replaced by concrete acceptance criteria: each invariant I1–I9 either structurally enforced or explicitly accepted as convention with a named test guarding it (§5). |

**Good old ideas that current code made harder, kept in adapted form:** the
local/remote metadata split (harder now because five hydration call sites and the operation
queue thread through `MetadataManager`'s boolean parameter — the adapted version renames the
operations instead of relocating them, §4.3); and interface standardization (harder because the
concrete types leaked into `OperationRepo`'s deserialization contract,
`src/sync/OperationRepo.ts:26-35` — the adapted version keeps those deps but narrows them).

---

## 4. Revised Architecture

### 4.1 Layers and seams

Five seams, chosen so a consumer can reason about one layer without reading the others. Only
interfaces that either (a) have two real implementations or (b) are required for testing without
MMKV/Firebase/React get an interface; everything else stays a concrete class.

```
┌────────────────────────────────────────────────────────────────┐
│ Public API: Ganon / LocalGanon  (typed KV + lifecycle + events)│
├────────────────────────────────────────────────────────────────┤
│ SyncEngine        hydration/backup pipelines, operation queue, │
│                   conflict & integrity policy (pure functions)  │
├──────────────────────────┬─────────────────────────────────────┤
│ MetadataStore (local,    │ RemoteMetadata (per-document cache  │
│ sync, default-returning) │ + flush queue, async)               │
├──────────────────────────┴─────────────────────────────────────┤
│ KeyRouter        key → {document, docField|subcollection},     │
│                  reserved-key validation (pure, built once)    │
├────────────────────────────────────────────────────────────────┤
│ Ports: KeyValueStore (MMKV)  ·  CloudStore (FirestoreAdapter)  │
│        Clock / Scheduler (timers)                              │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Ports (the only new interfaces)

**Problem solved:** `new MMKV()` is hardcoded in `StorageManager` (`:12-14`) and `OperationRepo`
(`:47`); `getFirestore()` is hardcoded in `FirestoreAdapter` (`:18`) and
`FirestoreReferenceManager` (`:17`). Consequence: nothing below the public API is testable
without jest module mocks, and `src/utils/MMKVFaker.ts` — a perfectly good fake — sits unused.
**Cost:** two small interfaces, one constructor parameter each, default arguments preserve
current behavior. **Why the benefit wins:** this single change makes every layer above testable
with plain constructor injection; it is the cheapest line in this document.

```ts
interface KeyValueStore {            // MMKV shape; MMKVFaker already satisfies it
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  contains(key: string): boolean;
  clearAll(): void;
}

interface Clock { now(): number }
interface Scheduler {                // wraps setTimeout/setInterval; FakeScheduler in tests
  schedule(fn: () => void, ms: number): CancelHandle;
  repeat(fn: () => void, ms: number): CancelHandle;
}
```

`IFirestoreAdapter` already exists; the change is that `FirestoreAdapter` *receives* its
Firestore instance and `FirestoreReferenceManager` receives the adapter's instance instead of
calling `getFirestore()` twice — also fixing the duplicate reference-manager construction
(`FirestoreManager.ts:39` vs `DependencyFactory.ts:41-44`).

Representative usage:

```ts
const storage = new StorageManager<T>(kv ?? new MMKV());
```

**No `Serializer` interface.** Serialization is JSON at the local boundary
(`StorageManager.ts:26,44`) and `DataProcessor` at the Firestore boundary — one implementation
each, not varied per key, not branched inline anywhere. Extracting a strategy here would be
pattern-as-virtue.

### 4.3 Metadata subsystem (the old proposal's target, adapted)

**Problem solved:** two writers through two paths to one store (D2), mixed cache/flush concerns
(old issues 1/5), and — the load-bearing one — I3 protected only by a `boolean = true` default.

Split `MetadataCoordinator` into:

```ts
// Local. Synchronous. NEVER returns undefined — the {digest:'', version:0} default is
// the documented tombstone (I1, I2a). Never persists on read.
class MetadataStore<T> {
  get(key: KeyOf<T>): LocalSyncMetadata;          // default = NeverSynced tombstone
  isNeverSynced(key: KeyOf<T>): boolean;          // replaces `digest === ''` string checks
  recordLocalChange(key: KeyOf<T>, m: SyncMetadata): void;   // marks dirty for remote flush
  recordSyncedState(key: KeyOf<T>, m: SyncMetadata): void;   // hydration/restore: NEVER flushes
  updateStatus(key: KeyOf<T>, s: SyncStatus): void;
  clear(): void;
}

// Remote. Async. One per cloudConfig document. Read side only.
class RemoteMetadataCache<T> {
  fetch(keys?: string[]): Promise<MetadataStorage>;   // TTL-cached, dedupes in-flight fetch
  invalidate(): void;                                  // sync mark; next fetch refetches
}

// Remote. Write side only. Owns the debounce; takes Scheduler + Clock.
class MetadataFlushQueue<T> {
  enqueue(key: string): void;
  flush(): Promise<void>;
  cancelAll(): void;
}
```

How the invariants become structural:

- **I3** — the boolean parameter is gone. `recordLocalChange` vs `recordSyncedState` are
  different methods; hydration code physically cannot "forget the false." The five
  `}, false); // Don't schedule remote sync during hydration` call sites become
  `recordSyncedState(...)` and the comment becomes the method name.
- **I2a** — `isNeverSynced()` replaces scattered `!meta || !meta.digest || meta.digest === ''`
  checks (`SyncController.ts:268`, `:319`). The `''` sentinel remains the *serialized* form (no
  data-format change) but stops being the *programming* interface.
- **I1 (metadata)** — `get` keeps its never-undefined, never-persisting contract, now documented
  in the type instead of contradicted by `IMetadataBase`.
- **D7 (config)** — both remote classes take their TTL/debounce/strategy from the single
  resolved `GanonConfig` at construction; the private `CacheConfig` literal is deleted.
- `invalidate()` becomes a synchronous mark instead of the current mark-then-immediately-refetch
  (`MetadataCoordinator.ts:214-218`), which is what makes `needsHydration` currently trigger
  **one full metadata-document fetch per key per hydration pass**
  (`MetadataManager.ts:58-70` invalidates before every key check). Hydration of N keys in one
  document drops from N fetches to 1.

`MetadataManager` remains as a thin façade over these three (routing via KeyRouter), preserving
the public behavior of `get`/`needsHydration`/`getRemoteMetadataOnly`.

### 4.4 KeyRouter

**Problem solved:** the same key→document lookup implemented three times with three data
structures (D9), plus no validation that consumer keys avoid the reserved `_sync_metadata_`
namespace (I9). **Cost:** one ~60-line pure class built once from `cloudConfig`. **Why it wins:**
three deletions, one source of truth, and config-time rejection of reserved-key collisions —
`Ganon._validateConfig` already walks every key (`src/Ganon.ts:607-692`), so the check is two
lines there.

```ts
class KeyRouter<T> {
  route(key: KeyOf<T>): { document: string; kind: 'docField' | 'subcollection' } | undefined;
  isCloudKey(key: KeyOf<T>): boolean;
  allCloudKeys(): KeyOf<T>[];
}
```

### 4.5 SyncEngine and the atomic write protocol

**Problem solved:** I4 (D8) — the value/digest race that the integrity machinery compensates
for — plus an untestable 1,286-line `SyncController` whose constructor starts timers and kicks
off hydration (`src/sync/SyncController.ts:60-67`).

Changes:

1. **Write digest with data, as atomically as the storage shape allows.**
   `SetOperation` should write the value *and* a per-key digest `{d, v}` in the **same
   Firestore transaction** where possible. The debounced metadata flush remains only for
   status-only changes.

   **Honest atomicity bounds (verified against `ChunkManager`):**

   | Key kind | Write path | Atomicity claim |
   |---|---|---|
   | **`docKeys`** | Value is a field on the backup document; digest can live on the same document in the same txn (`FirestoreManager._backupDocumentField`, `src/firestore/FirestoreManager.ts:691-724`) | **Full:** mismatch window collapses to Firestore transaction atomicity. |
   | **Subcollection, small** | `dataSize ≤ 200_000` and `!forceChunk` → single `chunk_0` doc (`ChunkManager.ts:18`, `:263-265`, `writeSingleDocumentWithMerge`) | **Full** if parent-document digest is updated in the same txn as `chunk_0`. |
   | **Subcollection, chunked (sync path)** | `forceChunk` or `dataSize > 200_000` → `writeChunkedDataWithDiff` with `options.transaction` set — all chunk sets/deletes in **one** txn (`ChunkManager.ts:470-507`) | **Conditional:** atomic only while total txn ops stay within Firestore limits (~500 writes, ~10 MiB). `SetOperation` always passes a transaction (`SetOperation.ts:31-37`); there is no batched fallback on txn failure — oversized payloads fail the sync rather than partially commit. |
   | **Subcollection, chunked (non-txn path)** | Same helper without `options.transaction` → batches of **`BATCH_SIZE = 10`** chunks per `writeBatch`, **`BATCH_DELAY = 50` ms** between batches (`ChunkManager.ts:21-22`, `:509-549`) | **Partial:** window shrinks from ~1s debounce to **intra-batch** (≤10 chunks). Parent digest cannot be atomic with all chunks across batches. Used when `backup()` is called outside `SetOperation`'s transaction. |

   **Consequence (revised):** integrity failures should become rare for `docKeys` and
   small subcollections once digest co-locates with data in the txn. For large chunked
   subcollections they remain possible — recovery-strategy surface can shrink for the
   docKey/single-chunk paths only, not "stop being a normal operating mode" globally.
   Chunked subcollection work may additionally need a batched protocol that stamps digest
   only after the final batch (or accepts temporary digest lag during multi-batch writes).

   *This is the only step that touches the persisted format — see §6 step 6 for the
   forward-compatibility story.*
2. **Constructor does nothing.** `engine.start()` begins the interval; the automatic
   startup hydration moves to `Ganon`'s init path where it is visible and suppressible. Timers
   come from the injected `Scheduler`; time from `Clock`. The `markAsPending` debounce and the
   flush debounce become testable without real timers.
3. **Fix the restore metadata gap (D9 last bullet):** restore's per-key success path calls
   `recordSyncedState(key, {digest: computeHash(value), version: remote.v})`, so a restore is
   not followed by a full re-upload. **§8 Q2 — ships in step 5.**
4. **Conflict/integrity stay policy-shaped.** `ConflictResolver` is already a pure static class
   (`src/sync/ConflictResolver.ts`) — the one part of the sync layer that is unit-testable
   today. Keep that shape; integrity handling becomes a pure decision function
   `(computed, remote, config) → Recovery` executed by the engine.

### 4.6 Public API surface

Unchanged for consumers, with additions that give structural help for I1 and step 6 rollout.
Both hydration helpers are **login-cycle-aware** — a cold start while logged out must not
resolve/trigger as if hydration were complete.

```ts
class Ganon<T> {
  // existing: get/set/remove/upsert/contains, backup/restore/hydrate/forceHydrate,
  // login/logout, on/off/once, startSync/stopSync, clearAllData, destroy ...

  /** Read with an in-memory default. NEVER persists the default. (I1 as API, not comment.) */
  getOrDefault<K extends KeyOf<T>>(key: K, fallback: T[K]): T[K];

  /**
   * Resolves when the *current login cycle's* hydration attempt has completed.
   *
   * Lifecycle:
   * - Before first `login()`: pending (does NOT resolve immediately while logged out).
   * - On `login()`: returns a fresh pending promise; prior awaiters from a previous
   *   session are cancelled/superseded.
   * - On `logout()`: resets; next cycle starts pending again.
   * - Resolves on `hydrationComplete` for the current cycle (including zero keys restored).
   *
   * Managers gate cloud-synced writes: `await ganon.whenHydrated()` after login, not at
   * module init on a cold guest start.
   */
  whenHydrated(): Promise<void>;

  /**
   * Dev-mode guard (opt-in). Warns/throws when a cloud-configured key is written during
   * the `logged-in && hydration-pending` window for the current login cycle.
   *
   * Does NOT fire for guest-mode writes to cloud-configured keys — those are legitimate
   * under I8 (local write succeeds; `login()` catches up via `backup()`). Guest→login
   * semantics documented in §8 Q5 and Ganon README.
   *
   * config: { earlyWriteGuard?: 'off' | 'warn' | 'throw';
   *           digestReadMode?: 'legacy' | 'dual' | 'v2' }  // see §6 step 6
   */
}
```

Generation guards (I6) remain a consumer concern — they guard UI/framework state Ganon cannot
see — but login-cycle `whenHydrated()` plus the existing `hydrationComplete` event give
consumers stable anchors per session.

Extensibility is already satisfied: consumers add domains by extending `StorageMapping` and
`cloudConfig` with no library changes (verified in production — see `LTG_ADOPTION.md` evidence
table).

---

## 5. Testing Strategy

Ganon's own suite currently fakes MMKV via jest module mocks (`__mocks__/react-native-mmkv.ts`)
and builds mocks with unsound casts (`TestSetupUtils.ts`). Target state, per layer:

| Layer | Unit-tested with | No MMKV | No React | No timers |
|---|---|---|---|---|
| `KeyRouter`, `computeHash`, `ConflictResolver`, integrity policy, `DataProcessor` | nothing — pure | ✓ | ✓ | ✓ |
| `StorageManager`, `MetadataStore`, `OperationRepo` persistence | `MMKVFaker` (exists, `src/utils/MMKVFaker.ts`) injected as `KeyValueStore` | ✓ | ✓ | ✓ |
| `RemoteMetadataCache`, `MetadataFlushQueue` | `FakeFirestore` + `FakeScheduler`/`FakeClock` | ✓ | ✓ | ✓ (virtual time) |
| `ChunkManager`, `FirestoreManager` | `FakeFirestore` (in-memory docs/collections/ transactions/batches behind `IFirestoreAdapter`) | ✓ | ✓ | ✓ |
| `SyncEngine` | all of the above composed | ✓ | ✓ | ✓ |
| `Ganon` façade + events | full fake stack | ✓ | ✓ | ✓ |
| `useGanon` hook | React testing lib (only file that needs React) | ✓ | – | ✓ |

**Test doubles:** exactly three — `MMKVFaker` (exists), `FakeFirestore` (new, ~200 lines: path
tree of documents, `merge` semantics, transaction = synchronous callback with write buffer),
`FakeScheduler/FakeClock` (new, ~50 lines: `advance(ms)` runs due callbacks). No jest module
mocks below the React layer; no `as unknown as` casts.

**FakeFirestore limitation:** its transaction model runs the callback synchronously with no
contention, abort, or retry — sufficient for digest/value coherency and batch-ordering tests,
but not for validating Firestore transaction conflict/retry behavior. Contention paths remain
integration-test or manual scope.

**Singletons:** the library keeps no module singletons except `Log`; give it `Log.reset()` for
tests.

**Which existing bugs would have been caught by which Ganon test:**

| Bug (library code) | Test that catches it |
|---|---|
| Data/digest mismatch → integrity retry storms (I4) | `SyncEngine` + `FakeFirestore`: perform `set`, crash the flush (throw inside scheduled callback), hydrate from a second engine instance sharing the `FakeFirestore` — asserts digest and value never diverge for **docKeys** once writes are transactional. Separate test for chunked subcollection batched path: digest may lag across batches (§4.5). |
| Restore leaves stale local digests → full re-upload (D9) | `SyncEngine` test: `restore()` then `syncAll()` must produce zero operations. Fails on current code. |
| Metadata conflict strategy ignores user config (D7) | `RemoteMetadataCache` test constructing with `LOCAL_WINS` and asserting resolution — fails on current code since the private config wins. |
| `needsHydration` N-fetches-per-pass (D9/§4.3) | `FakeFirestore` read-counter assertion: hydrating 10 keys in one document performs 1 metadata fetch. |
| Post-login pre-hydrate eager write (I1 class) | `Ganon` integration test with `earlyWriteGuard: 'throw'` after `login()` during hydration-pending — catches without false-positiveing legitimate guest writes (I8). |
| Guest login → existing remote (§8 Q5 contract) | `Ganon` characterization test: `login()` restore path clobbers guest cloud keys; stash-merge is consumer-owned (see `LTG_ADOPTION.md`). |

Consumer-app history rows (manager eager writes, generation guards, migration ordering) are in
`LTG_ADOPTION.md` §5.

---

## 6. Incremental Migration Plan

Each step is independently shippable, leaves consumers working, and is revertible by reverting
the PR. Order matters: testability first, so every later step lands with tests.

### Prerequisites (§8 resolved)

Blocking questions Q2, Q4, Q5 are answered in §8. **Steps 4–5 and 8 are unblocked.**
Step 6 sub-step 2 remains gated until the **deploying consumer** confirms fleet coverage per
its adoption plan (abstract dual-signal criterion — capability stamp plus write-path analytics;
concrete thresholds are consumer-specific; see `LTG_ADOPTION.md` for one reference plan).
Order unchanged: **steps 1–3 first** so step 4+ lands with the fake stack underneath.

---

1. **Inject `KeyValueStore` + `Clock`/`Scheduler`** into `StorageManager`, `OperationRepo`,
   `SyncController`, `MetadataCoordinator`, `ChunkManager`, with production defaults
   (`new MMKV()`, real timers). Wire `MMKVFaker` into the test suite; delete the jest MMKV
   module mock. *No behavior change; revert = revert.*
2. **Build `FakeFirestore`; inject the Firestore handle** into `FirestoreAdapter` /
   `FirestoreReferenceManager`; collapse the duplicate reference-manager instances (D6).
   Land the `SyncEngine`-level characterization tests (current behavior, bugs and all) —
   these are the safety net for everything after.
3. **Extract `KeyRouter`;** delete the three duplicated lookups; add reserved-key validation to
   `_validateConfig`. *Pure refactor guarded by step-2 tests.*
4. **Split the metadata subsystem** (§4.3): `MetadataStore` / `RemoteMetadataCache` /
   `MetadataFlushQueue`; replace the `scheduleRemoteSync` boolean with
   `recordLocalChange`/`recordSyncedState`; route all config through resolved `GanonConfig`
   (fixes D7 — per §8 Q4); make `invalidate()` lazy (fixes the N-fetch hydration).
   **Also (§8 Q1):** adopt per-key monotonic versioning
   `version = max(Date.now(), lastKnownVersion + 1)` wherever a new version is stamped.
   `MetadataManager` façade keeps its public signatures so `SyncController` and `OperationRepo`
   diffs stay small.
5. **Fix restore's metadata gap** (D9) — per §8 Q2: **bug, ships.** Restore's per-key
   success path calls `recordSyncedState(key, {digest, version})` so the device is left
   `Synced`, not pending re-upload. *Ship separately from step 4.*
   **PR verification required:** confirm no path relies on the post-restore re-upload as a
   safety net for partial restore failures.
6. **Atomic data+digest writes** — ⚠️ **touches persisted data format.**

   *Forward-compatibility story:* **dual-write, higher-version-wins-read.**

   **Write side (mixed fleet):** New clients write the digest in **both** locations on every
   sync:
   - In-document (transactional, co-located with value where §4.5 allows)
   - Legacy `remote_metadata` map (debounced flush, for old clients)

   Old clients continue updating only the legacy map. Both locations carry `{d, v}`.

   **Read side (required — fixes mixed-fleet correctness hole):** For each key, compare
   `{d, v}` from in-document and legacy map:
   - **Higher `v` wins.**
   - If only one location exists, use it.
   - **Tie-break:** if `v` is equal but `d` differs (possible at ms granularity with two
     writers), **prefer in-document** deterministically so all readers resolve identically.
   - Never "prefer new" unconditionally.

   *Why:* New client writes both → old client updates value + legacy map only → in-document
   digest becomes stale. Prefer-new-read manufactures integrity failures for transitioning
   users. Version-based selection picks the old client's fresher legacy entry.

   **Rollout sub-steps** (each a separate shippable PR):
   1. Dual-write both locations; readers use higher-`v` rule + tie-break (fallback if one
      location missing). Default `digestReadMode: 'dual'`. **Unblocked.**
   2. Stop *reading* legacy map (keep dual-write one cycle). **Gated:** consumer confirms fleet
      coverage per its adoption plan — **both** a capability stamp (who *can* dual-write) and
      write-path analytics (who *is* dual-writing) must agree before switching
      `digestReadMode` from `'dual'` to `'v2'`. Ship sub-step 2 with `'v2'` **default-off**
      (`'dual'` remains active); consumer wires the knob to its own rollout system.

      **`GanonConfig.digestReadMode`** (names illustrative):
      - `'legacy'` — read legacy `remote_metadata` map only (pre-step-6 rollback)
      - `'dual'` — higher-`v` rule across in-document + legacy map (sub-step 1 default)
      - `'v2'` — read in-document digest only (sub-step 2+)

   3. Stop writing legacy map. Shrink integrity-recovery surface per §4.5 bounds (docKeys first).
      **Unblocked once sub-step 2 ships and stabilizes.**

   Reverting any sub-step restores the previous read/write mix without data loss because both
   locations stay populated through the transition.

7. **Slim `SyncController` into `SyncEngine`:** constructor side effects out (interval start and
   auto-hydration move behind explicit `start()` called from `Ganon`), hydration pipeline
   decomposed into policy functions. Public `Ganon` behavior unchanged.

   **Vocabulary constraint:** `SyncEngine` (including extracted policy functions and
   `SetOperation`/`DeleteOperation` as they live under the engine) must not reference
   Firestore-specific types or concepts — no Firestore transaction objects, document/collection
   references, chunk handling, or batch primitives in engine code or method signatures. The
   engine expresses remote operations as intents (e.g. "write this value with this digest and
   version," "read this value," "fetch metadata for these keys," "delete this value") and calls
   concrete `FirestoreManager` methods; the Firestore subsystem (`FirestoreManager` /
   `FirestoreAdapter` / `ChunkManager` / `FirestoreReferenceManager`) decides internally how to
   satisfy each intent, including transaction scoping and chunking per §4.5. Firestore vocabulary
   stops at the Firestore subsystem's boundary. This is not a new port or interface — the engine
   still calls `FirestoreManager` directly (§4.1); the constraint is about method *shape and
   naming*, not an abstraction layer. Same operations, same semantics, no persisted-format
   changes. Rationale: keeping backend vocabulary out of the engine is better layering on its
   own merits and keeps the engine/backend seam cleanly extractable if it's ever needed.

   **Audit work items** (verify against current source; list may grow during implementation):

   1. **`SetOperation` transaction scoping** — today `SetOperation.execute` calls
      `firestore.runTransaction` and passes the resulting transaction object into
      `firestore.backup(..., { transaction })` (`SetOperation.ts:31-37`). Under this constraint,
      the operation expresses "write value + digest atomically" (e.g. a single
      `writeValueWithDigest(key, value, digest, version)`-shaped call on `FirestoreManager`);
      the Firestore subsystem owns transaction creation, scoping, and the §4.5 atomicity
      decision table internally.
   2. **Chunking stays behind `FirestoreManager`** — confirm no engine-level knowledge of chunk
      counts, batch sizes, or `forceChunk` remains in sync/operation code after the slim; any
      `{ transaction }` options bag that leaks Firestore txn handles into callers is removed.
   3. **Intent-shaped remote I/O names** — hydration/backup/integrity paths call methods named
      for intent (`readValue`, `deleteValue`, `fetchRemoteMetadata`-shaped), not Firestore
      mechanics (`runTransaction`, `getCollectionRef`, `backupLastBackupToUserDocument`-shaped).
      Current `firestore.fetch` / `firestore.delete` are close; rename or wrap where names still
      encode storage shape (e.g. `_updateLastBackup` → a user-timestamp intent on
      `FirestoreManager`, not a "user document" write).
   4. **Key enumeration via `KeyRouter`** — `_getAllConfiguredKeys` today walks
      `firestore.cloudConfig` doc/subcollection key lists (`SyncController.ts:925-929`); route
      through `KeyRouter.allCloudKeys()` (step 3) so the engine does not traverse Firestore
      document layout.
   5. **Residual Firestore vocabulary in sync layer** — grep sync/ for `runTransaction`,
      `transaction`, `cloudConfig`, `DocumentReference`, `CollectionReference`, `WriteBatch`,
      `chunk`, and `@react-native-firebase/firestore` / `firebase/firestore` imports; eliminate
      or push each hit behind `FirestoreManager`.

   **PR acceptance (mechanical):** two greps, both must return zero matches under `src/sync/`
   after the rename:

   ```bash
   rg '@react-native-firebase/firestore|firebase/firestore' src/sync/
   rg 'FirebaseFirestore|DocumentReference|CollectionReference|WriteBatch|runTransaction|\{ transaction' src/sync/
   ```

   The engine may still depend on `FirestoreManager` as a concrete class — only Firestore
   *vocabulary* is excluded, not the dependency itself.

8. **Public API additions** — ship `getOrDefault`, login-cycle `whenHydrated`, opt-in
   login-cycle `earlyWriteGuard`, and `digestReadMode` (§6 step 6). Document §8 Q5 contract
   in Ganon README. Consumer adoption (guard rollout, manager migration, stash-merge tests)
   is tracked per consumer — see `LTG_ADOPTION.md` for the reference plan.

Steps 1–3, 7 touch no persisted bytes locally or remotely. Step 6 is the only format-touching
step and is flagged accordingly. There is no step at which old and new library versions must
ship together with consumer changes — no big bang.

---

## 7. Explicitly Rejected Alternatives

1. **Full Clean Architecture as written in the old proposal** (use-case layer, repository layer,
   generic cache service, DTO mapping between layers). Rejected: the library is ~8k lines with
   one production consumer and one storage backend per side. Each added layer costs a file, a naming
   scheme, and a mapping, and — per the audit — the layers it prescribes don't align with where
   the actual bugs are (the write protocol, the boolean default, the hardcoded constructors).
   We keep its two genuinely useful ideas (metadata split, interface discipline) in adapted form.

2. **Command pattern with undo/history** (old proposal Phase 4). Rejected: the shipped
   `OperationRepo` already provides the valuable 80% (queueing, persistence across restarts,
   retry with backoff, serialize/deserialize). `undo()` has no product requirement, would need
   before-images persisted per operation (real storage cost on device), and interacts unsolvably
   with remote state (undo of a synced set is not a local rollback, it's a *new* sync).

3. **Making the public API (and local layers) async** to unify with the remote side. Rejected:
   synchronous reads are the reason MMKV was chosen and the reason consumers can read persisted
   state during render, in migrations, and at startup without loading states. Typical production
   usage has dozens of inline `ganon.get(...)` call sites that would need restructuring. The
   sync/async boundary *is* the local/remote boundary; keeping them aligned is a feature.

4. **Oplog / event-sourced sync** (replace digest-comparison with an append-only per-key
   operation log, CRDT-style merge). Rejected: it genuinely solves conflicts that
   digest+timestamp cannot (concurrent field edits on two devices), but the product has a
   single-user, few-devices model where `LAST_MODIFIED_WINS` on whole values has been
   acceptable; the cost is a full persisted-format migration on both sides, unbounded log
   compaction work, and a rewrite of hydration. If multi-device concurrent editing becomes a
   requirement, revisit — the §4.5 transactional write is a prerequisite for that world anyway,
   so nothing here is throwaway.

5. **Generic `ICacheService<T>` shared by metadata and chunk caches** (old proposal l. 114-124).
   Rejected: the metadata cache needs TTL + pending-key dirty tracking; the chunk cache needs
   write locks + optimistic version stamps (`ChunkManager.ts:26-42`). A shared interface is the
   union of both — every method meaningless to one of its two users. They stay private to their
   owners.

6. **Multi-backend support** (e.g. a second cloud provider via a shared backend port). Considered
   and deferred until a second backend has a committed consumer; a one-implementation backend port
   would fail the same speculative-abstraction test as the rejected repository pattern (D6). Step 7's
   vocabulary constraint — intent-shaped calls on a concrete `FirestoreManager` with all Firestore
   mechanics behind that class — is what keeps that door cheap to open later without shipping
   speculative interfaces now.

---

## 8. Resolved Decisions (formerly open questions)

Recorded in writing July 2026. These unblock implementation per §6.

### Q1 — Wall-clock `version` (I7): **accident; fix in step 4**

Not an intentional trade-off. Adopt `version = max(Date.now(), lastKnownVersion + 1)` wherever
a new version is stamped. Format-preserving, per-key monotonic per device, and it hardens step
6's higher-`v` read rule against the same clock skew that makes `LAST_MODIFIED_WINS` fragile.
Fold into step 4 alongside metadata subsystem split.

### Q2 — Restore metadata gap: **bug; step 5 ships**

The post-restore re-upload is not merely wasteful — it is mildly dangerous. Post-restore backup
stamps fresh `Date.now()` versions on values the device merely *received*, which under
`LAST_MODIFIED_WINS` can stomp a genuinely newer write from another device in the race window.
"Local becomes authoritative after restore" was never a product decision. Restore should leave
the device in `Synced` state with metadata matching restored values.

**Step 5 ships.** PR must verify: no path relies on post-restore re-upload to repair partial
restore failures.

### Q3 — `LocalMetadataManager.get` never returns `undefined`: **confirmed deliberate**

The `{digest: '', version: 0, syncStatus: Synced}` default on miss (without persisting) is
intentional — I1/I2 depend on it (`LocalMetadataManager.ts:18-31`). Enshrine in
`MetadataStore`'s contract in step 4.

### Q4 — Metadata vs data conflict strategy: **unify via `GanonConfig`**

Two independent strategies was never intentional; it is the hardcoded-literal drift D7 documents
(`MetadataCoordinator.ts:41-46` ignores user config). Route metadata conflicts through
`GanonConfig.conflictResolutionConfig` in step 4.

Consumers using the default `LAST_MODIFIED_WINS` (the Ganon default when unset) see
behavior-neutral unification. Consumers configuring a non-default strategy must add a
characterization test before merge. Reference verification for one production consumer:
`LTG_ADOPTION.md` §8 Q4.

### Q5 — Guest writes + login catch-up: **intentional contract; document in README**

Guest-mode local writes succeeding with sync deferred until login, and `login()` catching up
via `backup()` when remote is empty, is intentional product semantics consumers rely on for
pre-auth onboarding (nickname, preferences, etc.).

**Document as a public contract** in Ganon README (step 8).

**Login into existing remote account** (`Ganon.ts:370-381`):

When a guest completes onboarding then signs into an account that **already has cloud state**,
`hasAnyRemoteData()` is true → `restore()` runs. The contract is **not** "restore blindly
overwrites all guest data" — it is:

> **Restore overwrites guest cloud-configured keys, except fields explicitly stashed before
> restore and re-merged after.**

Ganon does not implement stash-merge — it is a **consumer pattern** for fields that must
survive login-into-existing-account. One production consumer implements this for OAuth display
name; see `LTG_ADOPTION.md` §8 Q5 for the reference implementation and required tests.

Whether specific onboarding fields warrant stashing is a consumer product decision. The README
must name stash-merge as the sanctioned escape hatch so engineers do not fix cases ad hoc.

**Library test (step 8):** `Ganon` characterization test that `login()` → restore clobbers
generic guest cloud keys. Stash-merge survival is consumer-tested separately.

Once documented, `earlyWriteGuard` arms as spec'd (`logged-in && hydration-pending` only);
step 8 unblocks.

### Q6 — `lastRunMigration` cloud-synced: **moved to adoption plan**

Consumer cloudConfig concern (intentional; restored device inherits migration cursor).
Resolved decision and action item: `LTG_ADOPTION.md` §Q6.
