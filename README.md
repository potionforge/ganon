<h1 align="center">Welcome to GanonDB 👋</h1>
<p>
  <a href="https://www.npmjs.com/package/@potionforge/ganon" target="_blank">
    <img alt="Version" src="https://img.shields.io/npm/v/@potionforge/ganon.svg">
  </a>
  <a href="https://github.com/potionforge/ganon#readme" target="_blank">
    <img alt="Documentation" src="https://img.shields.io/badge/documentation-yes-brightgreen.svg" />
  </a>
  <a href="https://github.com/potionforge/ganon/graphs/commit-activity" target="_blank">
    <img alt="Maintenance" src="https://img.shields.io/badge/Maintained%3F-yes-green.svg" />
  </a>
  <a href="https://twitter.com/ro_gmzp" target="_blank">
    <img alt="Twitter: ro_gmzp" src="https://img.shields.io/twitter/follow/ro_gmzp.svg?style=social" />
  </a>
</p>

> React Native Ganon SDK provides seamless storage management and cloud backup capabilities using Firestore and a local storage manager (MMKV).

* 🏠 [Homepage](https://potionforge.com)
* 🖤 [npm](https://www.npmjs.com/package/@potionforge/ganon)

## Overview

GanonDB is a storage and backup management SDK that simplifies integrating Firestore and a local storage system in React Native projects. It provides a typed instance of a storage managers and a simple API for data locally as well as syncing to Firebase.

GanonDB automatically handles large object storage through intelligent chunking, eliminating the need for manual data segmentation. Developers can store objects of any size directly to the database, while the SDK transparently manages backend storage optimization.

Note: currently supports Firestore only

---

## Install

```sh
# npm
npm install @potionforge/ganon

# yarn
yarn add @potionforge/ganon
```

## Configuration


### Identifier Key

Pick an identifier key you will use to track users. This can be `email`, `external_id`, `user_id`, etc...


### Storage Mapping

Define a storage mapping interface. Include the identifier key.

This interface defines all key-value pairs that will be stored in your local database. You can include keys that you don't want to back up to the cloud. By defining this interface, GanonDB enforces type safety, provides intelligent autocomplete, and ensures compile-time validation of your data structure.

```ts
interface MyMapping extends BaseStorageMapping {
  <identifier_key>: string;   // required
  // add other type definitions
}
```

**Example Configuration**
```ts
import { BaseStorageMapping } from '@potionforge/ganon';
import { IWorkouts } from '../types';

interface MyMapping extends BaseStorageMapping {
  email: string;            // identifier key (required)
  workoutCount: number;
  customWorkouts: IWorkouts;
}
```

### Cloud Config

Data will be stored in Firestore as 1) document-level fields or 2) subcollections.

```
/users/<identifier>/backup/<document>/<document_fields>
/users/<identifier>/backup/<document>/<subcollection>/<chunk_number>
```

Define a configuration object for Firestore backups. Maps documents to document and sub-collection keys.

You can exclude the identifier key as this is handled automatically.

```ts
interface CloudBackupConfig {
  [key: string]: {                  // document name
    docKeys?: string[];             // document-level fields
    subcollectionKeys?: string[];   // subcollections
  }
}
```

When picking whether to set a field as a document-level field or a subcollection, consider the size of the object. Large objects should go in subcollections while document-level fields are great for primitives or smaller objects that you don't expect to change in size.

**Example Configuration:**

```ts
const CLOUD_CONFIG: CloudBackupConfig<MyMapping> = {
  fitness: {
    docKeys: ['workoutCount'],
    subcollectionKeys: ['workouts']
  },
  preferences: {
    docKeys: ['userPreferences']
  }
};
```

This configuration:

1. Maps local storage keys to Firestore documents and subcollections
2. Organizes data structure for efficient cloud backup

## Setup

Create a new file called `ganon.ts`. We must use the instance in order for our types to work as expected.

Export the instance for usage across your codebase.

```ts
import Ganon, { LogLevel } from "@potionforge/ganon";
import cloudBackupConfig from "./cloudBackupConfig";
import { StorageMapping } from "src/models/StorageMapping";

const logLevel = process.env.NODE_ENV === 'development' ? LogLevel.VERBOSE : LogLevel.NONE;

const config = {
  identifierKey: 'email',
  cloudConfig: cloudBackupConfig,
  autoStartSync: true,
  logLevel,
}

// Initialize once using your specialized type.
export const ganon: Ganon<StorageMapping> = Ganon.init<StorageMapping>(config);
```

### GanonDB Config Object

| Property         | Type                     | Description                                        |
|-----------------|-------------------------|----------------------------------------------------|
| `identifierKey` | `string`                | Unique user identifier key for users (e.g. `email`, `uid`) |
| `cloudConfig`   | `CloudBackupConfig<T>`   | Configuration object for Firestore backups where T is your custom storage mapping.        |
| `logLevel`   | `LogLevel`   | LogLevel enum        |
| `autoStartSync` | `boolean` | Whether to automatically start the sync interval on initialization. Default: true |
| `syncInterval` | `number` | Interval in milliseconds between automatic sync operations. If not specified, uses default interval |
| `remoteReadonly` | `boolean` | Whether the remote Firestore should be treated as read-only (backup-only configuration) |
| `conflictResolutionConfig` | `Partial<ConflictResolutionConfig>` | Optional configuration for handling data conflicts during sync operations |
| `integrityFailureConfig` | `Partial<IntegrityFailureConfig>` | Optional configuration for handling integrity failures during sync operations |


## Usage

### Basic Operations

```ts
import { ganon } from "../ganon";

ganon.set("workoutCount", 15);
```

It works the same for large objects:

```ts
const userWorkouts = {
  {
    workoutId: '770be2e4-72f7-4213-a016-de67963f20fd',
    exercises: [
      'b470a44a-683b-4a7f-9223-64464131b9e8'
      // ...
    ]
  },
  // ... 500 workouts
}

ganon.set("workouts", userWorkouts);    // GanonDB handles chunking
```

### User login

Ganon provides a smart `login()` method that automatically handles the login lifecycle:

- **App reopen**: If the same user is already logged in, it's treated as an app reopen (no-op)
- **Existing user**: If remote data is present, it restores from the cloud
- **New user**: If remote data is absent, it backs up local guest state to the cloud
- **Indeterminate remote**: If the remote probe cannot be determined (e.g. permission or network errors), login **refuses backup** and attempts restore instead — so an unknown cloud is never treated as empty

**Example:**

```ts
onAuthStateChanged(async (user) => {
  if (user?.email) {
    const result = await ganon.login(user.email);
    console.log(`Login action: ${result.action}`); // "noop", "restore", or "backup"
    // result.probe: "present" | "absent" | "indeterminate" | "skipped"
    // result.restoredKeys / result.restoreFailedKeys: restore quality (0 on backup/noop)
    // result.probeReason?: string — set only when probe === "indeterminate"
  }
})
```

**`LoginResult`:**

| Field | Type | Meaning |
|-------|------|---------|
| `action` | `"noop"` \| `"restore"` \| `"backup"` | What login performed |
| `probe` | `"present"` \| `"absent"` \| `"indeterminate"` \| `"skipped"` | Remote-data probe that drove the decision (`skipped` = no probe ran) |
| `restoredKeys` | `number` | Keys pulled from cloud (`0` for backup/noop; also `0` if restore hit an empty/unreadable remote) |
| `restoreFailedKeys` | `number` | Keys that failed during restore (`0` for backup/noop); non-zero with `probe: "present"` means a partial restore |
| `probeReason` | `string?` | Present only when `probe: "indeterminate"` — aggregated probe failure reason |

**Actions:**
- `action: "noop"` — Same user already logged in (app reopen); `probe` is `"skipped"` (no probe ran)
- `action: "restore"` — Restored from remote; inspect `probe` (`present` vs `indeterminate`) and `restoreFailedKeys` for quality
- `action: "backup"` — New user detected, backed up local guest state (`probe: "absent"`)

### User logout

Ganon provides a `logout()` method that automatically handles cleanup:

- **Backs up data** by default before logging out (can be skipped)
- **Stops sync interval** and cancels pending operations
- **Clears user identifier** from local storage

**Example:**

```ts
async logout() {
  // Backs up by default
  await ganon.logout();
  
  // Or skip backup if needed
  await ganon.logout({ backup: false });
}
```

**Note:** The old manual approach (`ganon.backup()` + `ganon.clearAllData()`) still works, but using `logout()` is recommended as it handles all cleanup automatically.

### Hydration

Every time the app is opened, GanonDB will automatically check the backend to see if something changed. If it did, it will hydrate those values.

### Events

You can subscribe to sync lifecycle events (e.g. to update root app state when automatic hydration finishes and any keys were restored).

**Events:**

| Event | When it fires | Payload |
|-------|----------------|--------|
| `hydrationComplete` | After any hydration finishes, including the automatic one when the app opens with a user logged in | `RestoreResult` (`restoredKeys`, `failedKeys`, `integrityFailures`, etc.) |
| `syncComplete` | After a full backup completes (`ganon.backup()`) | `BackupResult` |
| `restoreComplete` | After a full restore completes (`ganon.restore()`) | `RestoreResult` |

**API:** `on(event, listener)`, `off(event, listener)`, `once(event, listener)`.

**Example:**

```ts
ganon.on('hydrationComplete', (result) => {
  if (result.restoredKeys.length > 0) {
    // Update root state; some keys were hydrated from the cloud
    updateAppState({ hydratedKeys: result.restoredKeys });
  }
});

ganon.once('syncComplete', (result) => {
  console.log('First backup done:', result.backedUpKeys);
});
```

### Conflict Resolution & Integrity Failure Handling

Ganon provides robust systems to handle both data conflicts and integrity failures during synchronization.

#### Conflict Resolution Configuration

```ts
import { ConflictResolutionStrategy, ConflictMergeStrategy } from '@potionforge/ganon';

const config = {
  // ... other config options
  conflictResolutionConfig: {
    strategy: ConflictResolutionStrategy.LOCAL_WINS,
    mergeStrategy: ConflictMergeStrategy.DEEP_MERGE,
    notifyOnConflict: true,
    trackConflicts: true,
    maxTrackedConflicts: 100
  }
};
```

#### Conflict Resolution Strategies

1. **Local Wins**: Use local data as source of truth

```ts
strategy: ConflictResolutionStrategy.LOCAL_WINS
```

2. **Remote Wins**: Use remote data as source of truth

```ts
strategy: ConflictResolutionStrategy.REMOTE_WINS
```

3. **Last Modified Wins**: Use data with most recent timestamp

```ts
strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS
```

#### Integrity Failure Configuration

```ts
import { IntegrityFailureRecoveryStrategy } from '@potionforge/ganon';

const config = {
  // ... other config options
  integrityFailureConfig: {
    maxRetries: 3,
    retryDelay: 1000,
    recoveryStrategy: IntegrityFailureRecoveryStrategy.FORCE_REFRESH,
    notifyOnFailure: true
  }
};
```

#### Integrity Failure Recovery Strategies

1. **Force Refresh**: Refresh metadata and re-fetch data

```ts
recoveryStrategy: IntegrityFailureRecoveryStrategy.FORCE_REFRESH
```

2. **Use Local**: Trust local data over remote

```ts
recoveryStrategy: IntegrityFailureRecoveryStrategy.USE_LOCAL
```

3. **Use Remote**: Trust remote data over local

```ts
recoveryStrategy: IntegrityFailureRecoveryStrategy.USE_REMOTE
```

4. **Skip**: Skip problematic keys and continue

```ts
recoveryStrategy: IntegrityFailureRecoveryStrategy.SKIP
```

---

### Advanced Sync Operations

<details>
<summary><strong>Hydration with Conflict Resolution</strong></summary>

```ts
import { ConflictResolutionStrategy, IntegrityFailureRecoveryStrategy } from '@potionforge/ganon';

// Hydrate specific keys with custom conflict resolution
const result = await ganon.hydrate(
  ['workoutCount', 'workouts'],
  {
    strategy: ConflictResolutionStrategy.LOCAL_WINS,
    notifyOnConflict: true
  },
  {
    maxRetries: 5,
    recoveryStrategy: IntegrityFailureRecoveryStrategy.FORCE_REFRESH
  }
);

console.log(`Restored ${result.restoredKeys.length} keys`);
console.log(`Failed ${result.failedKeys.length} keys`);
```

</details>

<details>
<summary><strong>Force Hydration</strong></summary>

```ts
// Force hydrate specific keys regardless of version comparison
const result = await ganon.forceHydrate(
  ['userPreferences'],
  {
    strategy: ConflictResolutionStrategy.REMOTE_WINS
  },
  {
    recoveryStrategy: IntegrityFailureRecoveryStrategy.USE_REMOTE
  }
);
```

</details>

### Available Enums & Types
<details>
<summary><strong>Available Enums and Types</strong></summary>

Ganon exports several enums and types for configuration and type safety:

```ts
import {
  // Conflict Resolution
  ConflictResolutionStrategy,
  ConflictMergeStrategy,
  ConflictResolutionConfig,

  // Integrity Failure Handling
  IntegrityFailureRecoveryStrategy,
  IntegrityFailureConfig,

  // Sync Status
  SyncStatus,

  // Login / results
  LoginResult,
  LoginAction,
  LoginProbeStatus,
  RemoteDataProbeResult,
  RestoreResult,
  BackupResult,

  // Errors
  SyncError,
  SyncErrorType,
  IntegrityFailureError,

  // Events
  GanonEventName,
  GanonEventPayloadMap,
  GanonEventListener,

  // Logging
  LogLevel
} from '@potionforge/ganon';
```

#### Conflict Resolution Enums

* `ConflictResolutionStrategy.LOCAL_WINS` - Use local data
* `ConflictResolutionStrategy.REMOTE_WINS` - Use remote data
* `ConflictResolutionStrategy.LAST_MODIFIED_WINS` - Use most recent data

#### Integrity Failure Recovery Enums

* `IntegrityFailureRecoveryStrategy.FORCE_REFRESH` - Refresh metadata and re-fetch
* `IntegrityFailureRecoveryStrategy.USE_LOCAL` - Trust local data
* `IntegrityFailureRecoveryStrategy.USE_REMOTE` - Trust remote data
* `IntegrityFailureRecoveryStrategy.SKIP` - Skip problematic keys

#### Login types

* `LoginResult` - Return type of `ganon.login()` (see [User login](#user-login))
* `LoginAction` - `"noop"` \| `"restore"` \| `"backup"`
* `LoginProbeStatus` - `"present"` \| `"absent"` \| `"indeterminate"` \| `"skipped"`
* `RemoteDataProbeResult` - Discriminated probe outcome: `{ status: 'present' }` \| `{ status: 'absent' }` \| `{ status: 'indeterminate'; reason: string }`

#### Event types

* `GanonEventName` - `"hydrationComplete"` | `"syncComplete"` | `"restoreComplete"`
* `GanonEventPayloadMap` - Maps each event name to its payload type (`RestoreResult` or `BackupResult`)
* `GanonEventListener<N>` - Callback type for event `N`

#### Errors

* `SyncError` - Thrown/returned for sync failures; see [Sync failure diagnostics](#sync-failure-diagnostics)
* `SyncErrorType` - Error category enum (`SyncFailed`, `SyncNetworkError`, `SyncTimeout`, `SyncMultipleErrors`, etc.)
* `IntegrityFailureError` - Specialized `SyncError` for hash mismatches during sync

</details>

### Sync failure diagnostics

Sync operations surface failures as `SyncError` (and optionally leave per-key outcomes on result objects).

**`SyncError` fields / helpers:**

| Field / method | Meaning |
|----------------|---------|
| `type` | `SyncErrorType` category |
| `code` | Optional Firestore / underlying error code (e.g. `"permission-denied"`) |
| `cause` | Optional original error preserved for diagnostics |
| `childErrors` | Nested errors when `type` is `SyncMultipleErrors` |
| `getAllMessages()` | Flattened messages including child errors |

**Per-key outcomes** (non-throwing partial failures):

* `BackupResult.failedKeys` / `backedUpKeys` / `skippedKeys` — after `ganon.backup()` or `syncComplete`
* `RestoreResult.failedKeys` / `restoredKeys` / `integrityFailures` — after `ganon.restore()`, hydrate, or `restoreComplete` / `hydrationComplete`

```ts
import { SyncError, SyncErrorType } from '@potionforge/ganon';

try {
  await ganon.backup();
} catch (err) {
  if (err instanceof SyncError) {
    console.error(err.type, err.code, err.message);
    if (err.type === SyncErrorType.SyncMultipleErrors) {
      console.error(err.getAllMessages());
    }
  }
}
```

### Updating Data Externally

<details>
<summary><strong>External Data Updates with Metadata Management</strong></summary>

When updating data outside of the GanonDB SDK (e.g., directly through Firestore), you must also update the corresponding `remote_metadata` to maintain data integrity and prevent sync conflicts.

**Note:** This approach currently only works for document-level fields, not subcollections.

#### Required Steps

1. **Compute the hash** of the new data using GanonDB's `computeHash` function
2. **Prepare the metadata** with the new hash and timestamp
3. **Update both data and metadata atomically** using a Firestore transaction

#### Example Implementation

```ts
import { computeHash } from '@potionforge/ganon';

// Your new data
const newWorkoutCount = 25;

// Get current remote metadata
const userDocRef = firestore.collection('users').doc(userId).collection('backup').doc('fitness');
const userDoc = await userDocRef.get();
const remoteMetadata = userDoc.data()?.remote_metadata || {};

// Step 1: Compute hash and prepare metadata
const newRemoteMetadata = {
  ...remoteMetadata,
  workoutCount: {
    d: computeHash(newWorkoutCount), // 'd' = digest (hash)
    v: Date.now(),                   // 'v' = version (timestamp)
  },
};

// Step 2: Update both data and metadata atomically
await firestore.runTransaction(async (transaction) => {
  transaction.set(userDocRef, {
    workoutCount: newWorkoutCount,
    remote_metadata: newRemoteMetadata
  }, { merge: true });
});
```

#### The `computeHash` Function

The `computeHash` function generates a deterministic SHA-256 hash of any data structure:

```ts
import { computeHash } from '@potionforge/ganon';

// Basic usage
const hash = computeHash(myData);
```

**Function Signature:**
```ts
function computeHash(value: unknown): string
```

**Parameters:**

- `value`: Any data structure to hash (objects, arrays, primitives)

**Returns:** A 16-character hexadecimal string representing the truncated SHA-256 hash

**Key Features:**

- Handles large objects efficiently without deep copying
- Creates canonical string representation for consistent hashing
- Sorts object keys for deterministic results
- Skips undefined values to avoid hash inconsistencies
- Uses hex representation for numbers to avoid precision issues

#### Metadata Structure

The `remote_metadata` object follows this structure:

```ts
interface RemoteMetadata {
  [key: string]: {
    d: string;  // digest (hash of the data)
    v: number;  // version (timestamp)
  }
}
```

#### Important Notes

- **Document-level fields only**: This approach currently only works for document-level fields, not subcollections
- **Always use transactions** when updating both data and metadata to ensure consistency
- **The hash must match exactly** what GanonDB would compute for the same data
- **Update the timestamp** (`v`) to the current time to indicate when the data was last modified
- **Preserve existing metadata** for other keys by spreading the current `remoteMetadata`

</details>

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!

Feel free to check the [issues page](https://github.com/potionforge/ganon/issues).

## Show your support

Give a ⭐️ if this project helped you!

## Follow

* Twitter: [@ro_gmzp](https://twitter.com/ro_gmzp)
* Github: [@potionforge](https://github.com/potionforge)
* LinkedIn: [Rodrigo Gomez-Palacio](https://www.linkedin.com/in/rogomezpalacio)

## 📝 License

Copyright © 2025 Honey Wolf LLC
This project is [MIT Licensed](https://github.com/potionforge/ganon/blob/main/LICENSE).
