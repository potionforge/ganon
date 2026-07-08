# LetThemGo — Ganon Adoption Plan

**Status:** Consumer rollout plan for `@potionforge/ganon`, extracted from
`ARCHITECTURE_PROPOSAL_V2.md` v2.4 (decisions unchanged). The library architecture lives in
the proposal; this document holds everything **LTG-specific** — concrete gates, machinery,
tests, and tickets that a second Ganon consumer would implement differently.

**Cross-reference convention:** `§N` refers to section N of `ARCHITECTURE_PROPOSAL_V2.md`.

**Parallel handoffs (this week):** Ganon repo → library steps 1–3 (proposal §6). App repo →
I1 eager-write fixes, semver comparator, `cloudConfig` comment (below). All four independent.

---

## Status overview

| Status | Meaning |
|---|---|
| **Green — ticket now** | LTG app work; no Ganon library dependency |
| **Unblocked — awaits library step N** | LTG work is spec'd; blocked only until Ganon ships step N |
| **Blocked** | Waiting on prior rollout, tests, or acceptance criteria |
| **Ganon repo** | Library PR in `@potionforge/ganon`; LTG has no action |

| Item | Proposal ref | Status | Notes |
|---|---|---|---|
| I1 violations — `DataInitializationManager`, `NoContactManager` | §2 I1 | **Green — ticket now** | Fix independent of all Ganon steps |
| Semver migration ordering (I5) | §2 I5 | **Green — ticket now** | `"1.10.0"` lex-sorts before `"1.9.0"`; imminent at `1.6.0` |
| Q6 — `lastRunMigration` comment in `cloudConfig.ts` | §Q6 below | **Green — ticket now** | One-line comment; no Ganon dependency |
| Steps 1–3 (inject ports, FakeFirestore, KeyRouter) | §6 steps 1–3 | **Ganon repo** | No LTG code required |
| Steps 4–5, 7–8 (library APIs + fixes) | §6 steps 4–5, 7–8 | **Ganon repo** | LTG adoption portions below track separately |
| Test-recipe migration (`LocalGanon` over `MMKVFaker`) | §5 | **Unblocked — awaits library step 1** | Replace per-file `jest.mock("@/services/ganon/ganon")` |
| Step 6 sub-step 1 (dual-write + `ensureDigestV2Capable`) | §6 step 6.1 | **Unblocked — awaits library §6 step 6** | LTG ships capability stamp with dual-write Ganon version |
| Step 6 sub-step 2 (stop reading legacy map) | §6 step 6.2 | **Blocked** | Dual-signal acceptance criteria (§ below) + `digestReadMode: 'v2'` |
| Step 6 sub-step 3 (stop writing legacy map) | §6 step 6.3 | **Blocked** | After 6.2 stabilizes |
| Q5 stash-merge characterization test | §8 Q5 | **Partial** | OAuth half covered (`LoginManager.test.ts:119-131`); extend with generic guest-key assertion |
| Step 8 adoption — `earlyWriteGuard`, `whenHydrated()` | §6 step 8, §4.6 | **Unblocked — awaits library step 8** | Also blocked on Q5 test completion |

---

## Post-merge bucket (after Ganon PRs 4+5 land)

Single checklist so follow-ups do not evaporate across repos. None block opening or merging the
stack; all are the first tranche after the library ships to LTG.

| # | Repo | Item | Notes |
|---|---|---|---|
| 1 | **Ganon** | Un-skip conflict-resolution failure test | `SyncController.test.ts` → `it.skip('should handle conflict resolution failure gracefully')`. Original excuse (static-method mocking) is obsolete: `SyncEngine` now accepts injected `Clock` / `Scheduler` / fakes — rewrite against `FakeFirestore` + port injection, no static mocking. Proof the testability investment pays off. |
| 2 | **LTG app** | `HydrationWaitReason` branching in post-login reload paths | `whenHydrated()` resolves `'hydrated' \| 'logged-out' \| 'login-failed'`. Post-login managers that `await whenHydrated()` must branch on `'logged-out'` and `'login-failed'` (e.g. return before reading user-scoped cache) — especially reload paths that run across logout/login boundaries. |
| 3 | **LTG app** | I1 — `DataInitializationManager` | Writes default `strugglePreference` before hydrate (`:50-51`). Switch to get-or-default / gate until hydrated. |
| 4 | **LTG app** | I1 — `NoContactManager` | Writes default no-contact state before hydrate (`:76-84`). Same pattern as `AwardManager.ts:28-42`. |

Items 3–4 are duplicated in **Immediate tickets** below for detail; this table is the
post-merge rollup.

---

## Immediate tickets (no Ganon step required)

### I1 — live eager-write violations

Two call sites still write defaults before hydrate and can clobber remote data:

| File | Issue |
|---|---|
| `app/managers/DataInitializationManager.ts:50-51` | Writes default `strugglePreference` |
| `app/managers/NoContactManager.ts:76-84` | Writes default no-contact state |

**Action:** Audit each (may run before login — separate from post-login `earlyWriteGuard`).
Fix or gate with the same get-or-default pattern used in `AwardManager.ts:28-42`
(regression test: `AwardManager.test.ts:81-87`).

### I5 — semver-aware migration ordering

`MigrationManager.ts:156` orders migration keys lexicographically. At app version `1.6.0`,
registering `"1.10.0"` will run before `"1.9.0"`.

**Action:** Semver comparator in LetThemGo's `MigrationManager` (app ticket, not Ganon core).
The `lastRunMigration` cursor remains cloud-synced (`cloudConfig.ts:50`) so restored devices
inherit it — see Q6.

### Q6 — `lastRunMigration` cloud-synced: **intentional**

Restored device inherits migration cursor because restored data is already migrated.
Cloud-syncing the cursor via `cloudConfig` is intentional for LTG.

**Action:** Add comment at the `lastRunMigration` entry in
`app/services/ganon/cloudConfig.ts` explaining why it must stay cloud-backed.

---

## §5 — App-side tests (which bug, which test)

Rows moved from the proposal's bug table. Library-provable rows stay in `ARCHITECTURE_PROPOSAL_V2.md` §5.

| Bug (LTG history/code) | Test that catches it |
|---|---|
| AwardManager eager write (write-of-default before hydrate clobbered remote awards; fixed at `AwardManager.ts:28-42`) | App contract test (`AwardManager.test.ts:81-87`). After library step 8: `earlyWriteGuard: 'throw'` in jest setup catches post-login pre-hydrate writes without false-positiveing guest writes (§8 Q5 / I8). |
| DM generation guards (I6) | `useDirectMessageThread.generationGuard.test.ts` — cache persists unconditionally; UI guarded by generation |
| Migration ordering `"1.10.0" < "1.9.0"` (I5) | `MigrationManager` test with those two versions registered |
| Guest onboarding → login to existing account (§8 Q5) | Characterization test: generic guest cloud keys clobbered by restore **and** stashed OAuth profile survives post-restore merge. Half covered today (`LoginManager.test.ts:119-131`); extend with generic guest-key assertion |

---

## §6 step 6 — Digest v2 rollout (LTG machinery)

The library defines the dual-write protocol, higher-`v` read rule, tie-break, and
`GanonConfig.digestReadMode` knob (§6 step 6). LTG owns fleet coverage, capability stamping,
analytics, and wiring the read-mode knob to remote flags.

### Sub-step 1 — ship with dual-write Ganon version

**`ensureDigestV2Capable()`** — idempotent reconciler, same pattern as `ensureDmCapable()`
(`app/services/ganon/ensureDmCapable.ts:4-14`):

- Stamps `digestV2Capable=true` on the logged-in user's Ganon backup
- Runs post-login across all six `LoginManager` paths (same placement discipline as
  `ensureDmCapable("LoginManager")` — after `ganon.login()` completes so restore cannot
  clobber a pre-restore stamp)
- Add `digestV2Capable` to `StorageMapping` + `cloudConfig` (mirror `dmCapable` at
  `StorageMapping.ts:122`)

Leave `digestReadMode: 'dual'` (library default for sub-step 1).

**Known flush races (library step 6.1, documented — not fixed in this series):**

- **Stale re-assertion (fixed in 6.1):** spreading the cached `remote_metadata` map into flush
  payloads regressed concurrent writers' entries. Fixed by writing pending keys only; Firestore
  `merge: true` deep-merges nested map entries.
- **Fetch→resolve→write on pending keys (pre-existing):** another client can update a pending
  key between pre-flush fetch and `setDocument`; LAST_MODIFIED_WINS resolves against a snapshot
  that may be stale. Same window as main, minus the spread hazard. Closing fully needs a
  Firestore transaction — out of scope for step 6.1.
- **Legacy-vs-legacy (transition window):** old clients had the spread hazard among themselves;
  new clients are shielded by dual-read (higher-version-wins vs in-document digest). Sunset
  decision in sub-step 3 should account for remaining legacy-only writers.
- **Legacy map flush at logout (pre-existing):** `logout()` runs `backup()` (which writes data
  and in-document digest atomically via `syncValueWithDigest`), then `cancelPendingOperations()`
  which cancels the debounced `MetadataFlushQueue` without flushing (~1s debounce). A legacy-only
  client reading that user's doc may see a stale `remote_metadata` entry while the in-document
  digest is current. Not data loss — dual-read protects new clients — but a mixed-fleet read
  hazard until sub-step 3 stops writing the legacy map. Fix path: drain `syncToRemote()` on all
  coordinators before teardown, or accept until legacy map sunset.

### Sub-step 2 — acceptance criteria (both signals must agree)

Do **not** switch to `digestReadMode: 'v2'` until **both** pass:

| Signal | Criterion |
|---|---|
| **Capability flag** | ≥98% of users active in the trailing 30 days carry `digestV2Capable=true` |
| **Analytics** | Legacy-only digest writes in BigQuery are <1% of all digest writes for **14 consecutive days** |

The flag identifies clients that *can* dual-write; analytics catch capable clients failing to
dual-write. One-sided criteria have burned us on blended metrics — two cheap signals that must
agree.

**Kill-switch:** wire `GanonConfig.digestReadMode` to LTG's remote feature-flag system.
Sub-step 2 read-rule change ships **default-off** (`'dual'`, not `'v2'`) so a bad read rollout
is a config flip, not an app release. Enable `'v2'` only after both criteria pass.

### Sub-step 3 — stop writing legacy map

After sub-step 2 stabilizes, coordinate with library step 6.3. Shrink integrity-recovery
surface per proposal §4.5 (docKeys first).

**Known deferral (M3):** `DeleteOperation` removes the value but leaves the `digestMap` entry
behind. **Symptom to expect in the wild: deleted keys churn `needsHydration` until `digestMap`
is cleaned.** Every subsequent `start()`/hydration sees a remote digest for the deleted key,
flags `needsHydration`, fetches, gets `undefined`, and skips — so `needsHydration` never clears.
This is not data loss, but it means a perpetual per-`start()` re-check for every deleted key,
forever, plus a misleading signal if you ever alert on hydration anomalies. Stale entries will
also pollute step 6.2 fleet-verification queries (`hasAnyRemoteData`, analytics). Track cleanup
with 6.2 work (delete must also clear the `digestMap` entry).

---

## §8 Q4 — LTG verification (behavior-neutral unification)

LetThemGo's `ganon.ts` does **not** pass `conflictResolutionConfig` (`ganon.ts:8-14`).
Both data and metadata use Ganon's default `LAST_MODIFIED_WINS` (`SyncController.ts:111-112`).
Routing metadata conflicts through `GanonConfig.conflictResolutionConfig` (proposal §6 step 4)
is **behavior-neutral for LTG today**.

### `autoStartSync` — explicit in LTG today

LTG's README example and `ganon.ts` wiring pass `autoStartSync: true` explicitly
(`README.md` config sample). Omitted `autoStartSync` now resolves to `true` everywhere
via `resolveGanonConfig` (sync interval, hydration on init/login, and legacy metadata
flush scheduling). This unifies a pre-v2.5 asymmetry where omitted `autoStartSync`
scheduled metadata flushes but did not auto-start sync/hydration. **LTG blast radius:
zero** — already explicit. New consumers should treat omission as opt-in to full auto-sync.

---

## §8 Q5 — Stash-merge implementation

The **contract** lives in the proposal §8 Q5 and Ganon README (library-documented behavior).
LTG implements and tests it.

### Reference implementation — OAuth display name

`LoginManager` stashes `pendingOAuthUserProfile` before auth (`LoginManager.ts:380-387`), then
calls `applyPendingOAuthUserProfileAfterRestore()` post-restore (`:113-131`, `:202`) to merge
the OAuth name back into the hydrated user row.

That stash-merge pattern is the **sanctioned escape hatch** for any field that must survive
login-into-existing-account — not ad hoc one-offs.

### Required characterization test (step 8 adoption)

On guest-onboarding → login-to-existing-account, assert **both halves**:

1. Generic guest cloud keys are overwritten by restore (remote wins).
2. Stashed fields survive via post-restore merge (OAuth name is the reference case today;
   `LoginManager.test.ts:119-131` covers half — extend with a generic guest-key assertion).

Whether other onboarding fields (e.g. fresh no-contact date when signing into a two-year-old
account) warrant stashing is a **product call, deferrable** — but use the stash-merge mechanism,
not inline fixes.

---

## §6 step 8 — LTG adoption work (after library ships APIs)

Once library step 8 lands (`getOrDefault`, `whenHydrated`, `earlyWriteGuard`):

1. **Document** §8 Q5 contract in app onboarding/auth docs (points to Ganon README).
2. **Ship** Q5 characterization test (above).
3. **Migrate managers** to `await ganon.whenHydrated()` after login for cloud-synced writes
   (not at module init on cold guest start).
4. **Enable guards:** `earlyWriteGuard: 'warn'` in dev builds; `'throw'` in jest setup for
   post-login pre-hydrate paths. Login failures settle the hydration cycle with
   `'login-failed'` before rethrowing so a failed restore/backup does not leave writes blocked
   under `'throw'` and `whenHydrated()` waiters can branch to retry or surface an error.
5. **Migrate test recipe:** replace per-file `jest.mock("@/services/ganon/ganon")` with
   `LocalGanon` over `MMKVFaker` (proposal §5 pattern).

### Known issue — `login()` retry noop after transient failure

`login()` sets the identifier before `hasAnyRemoteData()` / restore. If restore or backup
throws, the user is half-logged-in (identifier set, remote data not restored). A retry of
`login(sameUserId)` hits the same-user noop path and **never restores remote data**. Pre-existing
ordering; more visible now that waiters pending at failure resolve `'login-failed'`; subsequent
`whenHydrated()` calls on the half-state resolve `'hydrated'` until the ordering fix lands.
**Candidate fix (separate PR):** roll back the identifier write in the login catch, or resolve
waiters as `'logged-out'` and clear the identifier. Do not fold into the step 4+5 merge — partial
guest/local data mixing on rollback needs product thought.

---

## Evidence citations (why LTG appears in the proposal)

These patterns are cited in `ARCHITECTURE_PROPOSAL_V2.md` as *consumer-side evidence* for
library invariants — not as dependencies of Ganon core steps:

| Pattern | Proposal invariant | LTG location |
|---|---|---|
| get-or-default, no eager persist | I1 | `AwardManager.ts:28-42`, managers listed in §2 |
| Migration cursor + cloud sync | I5 | `MigrationManager.ts`, `cloudConfig.ts:50` |
| Generation guard (cache vs UI) | I6 | `useDirectMessageThread.ts` |
| Hashmap absence ≠ false | I2c | `communityFeedUpvotePersistence.ts` |
| Sync read at render / migration | D4 | `MigrationManager.ts:126-128` |
| Extensibility (DM cache, zero Ganon changes) | §4.6 | `StorageMapping` + `cloudConfig` entries |
