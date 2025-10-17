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

Note: Supabase & other DBs are coming soon.

---

## Install

```sh
# npm
npm install @potionforge/ganon

# yarn
yarn add @potionforge/ganon
```

## Configuration

GanonDB requires configuration to map local storage data to Firestore backup.

### Storage Mapping

Define a storage mapping interface. Include the identifier key you will use to track users.

```ts
import { BaseStorageMapping } from '@potionforge/ganon';

// Define a mapping interface
interface MyMapping extends BaseStorageMapping {
  email: string;            // identifier key
  booksRead: number;
  books: { [key: string]: { title: string } };
}
```

### Cloud Config

Define a configuration object for Firestore backups. Maps documents to document and sub-collection keys.

You can exclude the identifier key as this is handled automatically.

```ts
interface CloudBackupConfig {
  [key: string]: {
    docKeys?: string[];
    subcollectionKeys?: string[];
    type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
    schema?: JSONSchema7;  // JSON Schema for validating object/array data
  }
}
```

**Example with Schema Validation:**

```ts
import { CloudBackupConfig } from '@potionforge/ganon';
import { JSONSchema7 } from 'json-schema';

// Define a mapping interface
interface MyMapping extends BaseStorageMapping {
  email: string;            // identifier key
  booksRead: number;
  books: {
    [key: string]: {
      title: string;
      author: string;
      rating: number;
      genres: string[];
      publishedDate: string;
    }
  };
  userPreferences: {
    theme: 'light' | 'dark';
    notifications: boolean;
    fontSize: number;
  };
}

// Define JSON schemas for validation
const bookSchema: JSONSchema7 = {
  type: 'object',
  required: ['title', 'author', 'rating', 'genres', 'publishedDate'],
  properties: {
    title: { type: 'string', minLength: 1 },
    author: { type: 'string', minLength: 1 },
    rating: { type: 'number', minimum: 0, maximum: 5 },
    genres: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1
    },
    publishedDate: {
      type: 'string',
      format: 'date'
    }
  }
};

const userPreferencesSchema: JSONSchema7 = {
  type: 'object',
  required: ['theme', 'notifications', 'fontSize'],
  properties: {
    theme: {
      type: 'string',
      enum: ['light', 'dark']
    },
    notifications: { type: 'boolean' },
    fontSize: {
      type: 'number',
      minimum: 12,
      maximum: 24
    }
  }
};

const cloudConfig: CloudBackupConfig<MyMapping> = {
  reading: {
    docKeys: ['booksRead'],
    subcollectionKeys: ['books'],
    type: 'object',
    schema: bookSchema
  },
  preferences: {
    docKeys: ['userPreferences'],
    type: 'object',
    schema: userPreferencesSchema
  }
};
```

This configuration:
1. Defines strict schemas for both books and user preferences
2. Validates data structure and types before syncing to Firestore
3. Ensures required fields are present
4. Enforces value constraints (e.g., rating between 0-5, font size between 12-24)
5. Validates date formats and enum values

When using this configuration, Ganon will automatically validate data against these schemas before syncing to Firestore. If validation fails, the sync operation will be rejected and an error will be thrown.

### Ganon Config

| Property         | Type                     | Description                                        |
|-----------------|-------------------------|----------------------------------------------------|
| `identifierKey` | `string`                | Unique user identifier key for users (e.g. `email`, `uid`) |
| `cloudConfig`   | `CloudBackupConfig<T>`   | Configuration object for Firestore backups where T is your custom storage mapping.        |
| `logLevel`   | `LogLevel`   | LogLevel enum        |
| `conflictResolutionConfig` | `Partial<ConflictResolutionConfig>` | Optional configuration for handling data conflicts during sync operations |
| `integrityFailureConfig` | `Partial<IntegrityFailureConfig>` | Optional configuration for handling integrity failures during sync operations |

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

## Setup

Create a new file called `ganon.ts`. We must use the instance in order for our types to work as expected.

Export the instance for usage across your codebase.

```ts
import Ganon, { LogLevel } from "@potionforge/ganon";
import cloudBackupConfig from "./cloudBackupConfig";
import { StorageMapping } from "src/models/StorageMapping";

const logLevel = process.env.NODE_ENV === 'development' ? LogLevel.VERBOSE : LogLevel.NONE;

// Initialize once using your specialized type.
export const ganon: Ganon<StorageMapping> = Ganon.init<StorageMapping>({
  identifierKey: 'email',
  cloudConfig: cloudBackupConfig,
  logLevel,
});
```

## Usage

### Basic Operations

```ts
import { ganon } from "<path_to_file>/ganon";

ganon.set("booksRead", 5);
```

### Advanced Sync Operations

#### Hydration with Conflict Resolution

```ts
import { ConflictResolutionStrategy, IntegrityFailureRecoveryStrategy } from '@potionforge/ganon';

// Hydrate specific keys with custom conflict resolution
const result = await ganon.hydrate(
  ['booksRead', 'books'],
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

#### Force Hydration

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

#### Restore All Data

```ts
// Restore all data from cloud (no per-invocation config needed)
const result = await ganon.restore();
```

### Available Enums and Types

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
This project is [Proprietary Licensed](https://github.com/potionforge/ganon/blob/main/LICENSE).
