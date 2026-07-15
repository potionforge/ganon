# Remote metadata cache semantics

Freshness contract for `MetadataCoordinator.getRemoteMetadata` /
`MetadataManager.getRemoteMetadataOnly`. Written down after beta-6.2 found that
passing `keys` into `getRemoteMetadata` forced a Firestore `getDocument` per call
(restore amplification: ~N value reads + ~N metadata-doc reads).

## Cache model (current)

- One `MetadataCoordinator` per backup **document** (not per key).
- TTL: `maxAge` (default 5 minutes). Warm cache (`lastFetchTime` set, not expired)
  is served for **all** callers, including keyed ones.
- Keys select from the cache; they must **not** be treated as a cache-bypass.
- Callers that need fresher-than-TTL data must invalidate explicitly
  (`invalidateCache` / `invalidateCacheForHydration` / `hydrateMetadata`).

## Invalidate scope

`MetadataManager.invalidateCache(key)` → `_getCoordinator(key)` → that coordinator’s
`invalidateCache()` only:

1. Zeroes **that document’s** `lastFetchTime`
2. `getRemoteMetadata()` (unkeyed) → one `getDocument` for that backup doc

It does **not** invalidate other coordinators / other backup documents. Integrity
retry loops that call `invalidateCache(key)` then `getRemoteMetadataOnly(key)` are
bounded by `maxRetries × 1 document fetch` for the key’s doc — not a process-wide
cache wipe and not a per-key-set fan-out across documents.

## Call-site freshness contract

| Site | Needs fresher-than-TTL? | Already forces fresh? | Verdict |
|---|---|---|---|
| `probeRemoteData` → `getRemoteMetadataOnly` | No — tenure presence; TTL fine | No | Clear — same cache trust as before; keyed warm-cache is a win (fewer reads) |
| `restore` → `getRemoteMetadataOnly` | No — wants the just-warmed `hydrateMetadata` snapshot | `hydrateMetadata` → `invalidateCache` (full fetch per doc) first | Clear — this is why keyed must be cache-served |
| `hydrate` → `needsHydration` → coordinator `getRemoteMetadata()` | Yes | `invalidateCacheForHydration` before check | Clear — unkeyed path; invalidation upstream |
| `hydrate` → first `getRemoteMetadataOnly` | Yes (conflict/integrity) | Same invalidate via `needsHydration` moments earlier | Clear — reads warm post-invalidate |
| `hydrate` integrity retry loop | Yes — value/digest race | Explicit `invalidateCache` before each retry (must not rely on keys-as-bypass) | Clear when invalidate stays in the loop |
| `forceHydrate` → first `getRemoteMetadataOnly` | Yes | `invalidateCacheForHydration` per key before fetch | Clear |
| `forceHydrate` integrity retry loop | Yes | Same as hydrate — explicit invalidate before each retry | Clear when invalidate stays in the loop |
| `_forceMetadataRefresh` → `getRemoteMetadataOnly` | Yes | `invalidateCache` + `invalidateCacheForHydration` before read | Clear |
| `MetadataCoordinator.syncToRemote` → `getRemoteMetadata()` | TTL or already-fetched OK for pending flush | Unkeyed; fetches only if cache invalid | Clear — not keyed |
| `ensureConsistency` → `getRemoteMetadata()` | TTL | Unkeyed if invalid | Clear |
| `invalidateCache` → `getRemoteMetadata()` | Yes (definitionally) | Sets `lastFetchTime = 0` then fetches | Clear |

## Invariant for refactors

Any redesign of the metadata layer (see `ARCHITECTURE_PROPOSAL_V2.md` on beta-7)
must preserve each site’s freshness requirement: either TTL-tolerant reads stay
cache-served, or fresher-than-TTL sites keep an explicit invalidate (or equivalent)
before the read. Do not reintroduce “pass keys to force a Firestore read” as
implicit API — that was accidental, expensive on restore, and unreadable as a
contract.
