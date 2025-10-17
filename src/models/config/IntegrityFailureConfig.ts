import { IntegrityFailureRecoveryStrategy } from './IntegrityFailureRecoveryStrategy';

/**
 * Configuration for handling integrity failures during sync operations.
 * Defines retry behavior, recovery strategies, and notification settings.
 */
export interface IntegrityFailureConfig {
  /** Maximum number of retry attempts before applying recovery strategy */
  maxRetries: number;

  /** Delay in milliseconds between retry attempts (with exponential backoff) */
  retryDelay: number;

  /** Strategy to use when integrity failures persist after max retries */
  strategy: IntegrityFailureRecoveryStrategy;

  /** Whether to notify users when integrity failures occur */
  notifyOnFailure: boolean;
}
