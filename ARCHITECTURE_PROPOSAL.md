# Metadata Management Architecture Proposal

## Executive Summary

This document proposes a comprehensive refactoring of the metadata management system in Ganon to address current architectural issues and improve maintainability, testability, and scalability. The current system, while functional, suffers from tight coupling, mixed concerns, and inconsistent interfaces that make it difficult to maintain and extend.

## Current Architecture Analysis

### Existing Component Hierarchy

```
DependencyFactory
    ↓
SyncController
    ↓
MetadataManager (Facade/Router)
    ↓
MetadataCoordinatorRepo (Factory)
    ↓
MetadataCoordinator (Per-document coordinator)
    ↓
LocalMetadataManager (Local storage)
```

### Current Issues Identified

#### 1. **Violation of Single Responsibility Principle**
- `MetadataCoordinator` handles multiple concerns:
  - Remote metadata caching
  - Local metadata updates
  - Remote sync scheduling
  - Conflict resolution
  - Cache invalidation
  - Batch operations

#### 2. **Tight Coupling Between Layers**
- Circular dependency pattern: `MetadataManager` → `MetadataCoordinator` → `LocalMetadataManager`
- Direct method calls create rigid dependencies
- Hard to test components in isolation

#### 3. **Inconsistent Interface Contracts**
- `IMetadataBase` interface doesn't match implementations
- Missing async operations in interfaces
- Type mismatches between interface and implementation

#### 4. **Configuration Scattered Across Components**
- Configuration passed through multiple layers
- Each layer may have its own defaults
- Unpredictable behavior due to configuration drift

#### 5. **Mixed Concerns in MetadataCoordinator**
- Handles both local and remote operations
- Violates separation of concerns principle
- Makes testing and maintenance difficult

## Proposed Architecture

### Clean Architecture Implementation

```
┌─────────────────────────────────────────────────────────────────┐
│                    Application Layer                            │
│  SyncController, MetadataManager (Use Cases)                   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Domain Layer                                 │
│  Interfaces, Models, Business Logic                            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Infrastructure Layer                          │
│  LocalMetadataService, RemoteMetadataService, CacheService      │
└─────────────────────────────────────────────────────────────────┘
```

### Component Separation

#### 1. **Local Metadata Service**
```typescript
interface ILocalMetadataService<T extends BaseStorageMapping> {
  get(key: Extract<keyof T, string>): Promise<LocalSyncMetadata | undefined>
  set(key: Extract<keyof T, string>, metadata: LocalSyncMetadata): Promise<void>
  updateSyncStatus(key: Extract<keyof T, string>, status: SyncStatus): Promise<void>
  remove(key: Extract<keyof T, string>): Promise<void>
  clear(): Promise<void>
  has(key: Extract<keyof T, string>): Promise<boolean>
}
```

#### 2. **Remote Metadata Service**
```typescript
interface IRemoteMetadataService<T extends BaseStorageMapping> {
  fetchMetadata(keys: string[]): Promise<MetadataStorage>
  syncMetadata(keys: string[]): Promise<void>
  invalidateCache(): Promise<void>
  scheduleSync(key: string): Promise<void>
  cancelPendingSync(key: string): Promise<void>
}
```

#### 3. **Metadata Coordinator (Pure Coordination)**
```typescript
interface IMetadataCoordinator<T extends BaseStorageMapping> {
  coordinateLocalUpdate(key: string, metadata: LocalSyncMetadata, scheduleRemoteSync: boolean): Promise<void>
  coordinateRemoteSync(keys: string[]): Promise<void>
  coordinateCacheInvalidation(keys: string[]): Promise<void>
  coordinateConflictResolution(conflicts: ConflictInfo[]): Promise<ConflictResolutionResult[]>
}
```

#### 4. **Cache Service**
```typescript
interface ICacheService<T> {
  get(key: string): T | undefined
  set(key: string, value: T, ttl?: number): void
  invalidate(key: string): void
  invalidatePattern(pattern: string): void
  clear(): void
  isExpired(key: string): boolean
}
```

### Command Pattern Implementation

#### Metadata Operations as Commands
```typescript
interface IMetadataCommand {
  execute(): Promise<void>
  undo(): Promise<void>
  canUndo(): boolean
}

class UpdateMetadataCommand implements IMetadataCommand {
  constructor(
    private key: string,
    private metadata: LocalSyncMetadata,
    private localService: ILocalMetadataService<any>,
    private remoteService: IRemoteMetadataService<any>,
    private scheduleRemoteSync: boolean
  ) {}

  async execute(): Promise<void> {
    await this.localService.set(this.key, this.metadata)
    if (this.scheduleRemoteSync) {
      await this.remoteService.scheduleSync(this.key)
    }
  }

  async undo(): Promise<void> {
    // Implementation for rollback
  }

  canUndo(): boolean {
    return true
  }
}
```

#### Command Executor
```typescript
class MetadataCommandExecutor {
  private commandHistory: IMetadataCommand[] = []

  async executeCommand(command: IMetadataCommand): Promise<void> {
    try {
      await command.execute()
      this.commandHistory.push(command)
    } catch (error) {
      // Handle rollback if needed
      throw error
    }
  }

  async undoLastCommand(): Promise<void> {
    const lastCommand = this.commandHistory.pop()
    if (lastCommand && lastCommand.canUndo()) {
      await lastCommand.undo()
    }
  }
}
```

### Repository Pattern Implementation

#### True Repository Pattern
```typescript
interface IMetadataRepository<T extends BaseStorageMapping> {
  getMetadata(key: string): Promise<SyncMetadata | undefined>
  setMetadata(key: string, metadata: SyncMetadata): Promise<void>
  batchUpdateMetadata(updates: Map<string, SyncMetadata>): Promise<void>
  deleteMetadata(key: string): Promise<void>
  findMetadataByPattern(pattern: string): Promise<Map<string, SyncMetadata>>
}

class FirestoreMetadataRepository implements IMetadataRepository<any> {
  constructor(
    private adapter: IFirestoreAdapter,
    private userManager: IUserManager
  ) {}

  async getMetadata(key: string): Promise<SyncMetadata | undefined> {
    // Implementation
  }

  async setMetadata(key: string, metadata: SyncMetadata): Promise<void> {
    // Implementation
  }

  // ... other methods
}
```

## Implementation Plan

### Phase 1: Interface Standardization (High Priority)
**Duration**: 1-2 weeks
**Scope**: Fix interface contracts and type consistency

#### Tasks:
1. Update `IMetadataBase` interface to match actual implementations
2. Add missing async operations to interfaces
3. Standardize return types across all metadata operations
4. Update all implementations to match new interfaces

#### Deliverables:
- Updated interface definitions
- Consistent type contracts
- Updated implementations

### Phase 2: Service Separation (High Priority)
**Duration**: 2-3 weeks
**Scope**: Separate local and remote concerns

#### Tasks:
1. Extract `LocalMetadataService` from `MetadataCoordinator`
2. Extract `RemoteMetadataService` from `MetadataCoordinator`
3. Create `CacheService` for remote metadata caching
4. Update `MetadataCoordinator` to pure coordination role
5. Update `MetadataManager` to use new services

#### Deliverables:
- `LocalMetadataService` implementation
- `RemoteMetadataService` implementation
- `CacheService` implementation
- Refactored `MetadataCoordinator`

### Phase 3: Repository Pattern (Medium Priority)
**Duration**: 1-2 weeks
**Scope**: Implement proper repository pattern

#### Tasks:
1. Create `IMetadataRepository` interface
2. Implement `FirestoreMetadataRepository`
3. Update services to use repository pattern
4. Add batch operations support

#### Deliverables:
- Repository interface and implementation
- Batch operations support
- Updated service implementations

### Phase 4: Command Pattern (Low Priority)
**Duration**: 1-2 weeks
**Scope**: Implement command pattern for operations

#### Tasks:
1. Create command interfaces and base classes
2. Implement specific metadata commands
3. Create command executor
4. Update `MetadataManager` to use commands

#### Deliverables:
- Command pattern implementation
- Command executor
- Updated metadata operations

## Migration Strategy

### Backward Compatibility
- Maintain existing public APIs during transition
- Use adapter pattern to bridge old and new implementations
- Gradual migration of internal components

### Testing Strategy
- Unit tests for each new service
- Integration tests for service interactions
- End-to-end tests for complete workflows
- Performance tests for cache operations

### Rollback Plan
- Feature flags for new implementations
- Ability to revert to old implementations
- Comprehensive monitoring and alerting

## Benefits of Proposed Architecture

### 1. **Improved Testability**
- Each component has a single responsibility
- Easy to mock dependencies
- Isolated unit tests possible

### 2. **Enhanced Maintainability**
- Clear separation of concerns
- Reduced coupling between components
- Easier to understand and modify

### 3. **Better Flexibility**
- Easy to swap implementations
- Support for different storage backends
- Configurable behavior through interfaces

### 4. **Increased Consistency**
- Proper interface contracts
- Standardized error handling
- Uniform operation patterns

### 5. **Future Scalability**
- Clean architecture supports growth
- Easy to add new features
- Support for distributed systems

## Risk Assessment

### High Risk
- **Breaking Changes**: Interface changes may affect existing code
- **Performance Impact**: Additional abstraction layers may impact performance

### Medium Risk
- **Migration Complexity**: Large codebase requires careful migration
- **Testing Coverage**: Need comprehensive tests for new implementations

### Low Risk
- **Learning Curve**: Team needs to understand new patterns
- **Documentation**: Need to update documentation

## Mitigation Strategies

### For Breaking Changes
- Maintain backward compatibility during transition
- Use deprecation warnings for old APIs
- Provide migration guides

### For Performance Impact
- Benchmark new implementations
- Optimize critical paths
- Use lazy loading where appropriate

### For Migration Complexity
- Implement feature flags
- Gradual rollout strategy
- Comprehensive testing

## Success Metrics

### Technical Metrics
- Reduced cyclomatic complexity
- Improved test coverage (>90%)
- Reduced coupling metrics
- Performance benchmarks maintained

### Process Metrics
- Reduced bug reports
- Faster feature development
- Improved code review times
- Better developer satisfaction

## Conclusion

The proposed architecture addresses the current issues while providing a solid foundation for future growth. The phased implementation approach minimizes risk while delivering incremental value. The investment in refactoring will pay dividends in terms of maintainability, testability, and developer productivity.

The key to success will be maintaining backward compatibility during the transition and ensuring comprehensive testing coverage for all new implementations.
