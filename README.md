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

When a user logs in, you will want to restore the data.

**Example:**

```ts
onAuthStateChanged(async (user) => {
  if (user?.email) {
    ganon.set('email', email);  // log in by setting a value on the identifier_key
    await ganon.restore();
  }
})
```

### User logout

When a user logs out, you may want to make sure data is backed up.

```ts
async logout() {
  await ganon.backup();
  ganon.clearAllData();
}
```

### Hydration

Every time the app is opened, GanonDB will automatically check the backend to see if something changed. If it did, it will hydrate those values.

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

  // Results
  RestoreResult,
  BackupResult,

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
