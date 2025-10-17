import Log from '../../utils/Log';
import { sanitizeFieldName, findInvalidFieldNames } from './helpers/fieldNameValidation';
import { checkForCircularReferences, checkBasicConstraints, analyzeForFirestoreIssues, checkCommonIssues } from './helpers/dataValidation';
import { sanitizeForFirestore as transformSanitize, restoreFromFirestore as transformRestore } from './helpers/dataTransformation';

/**
 * Simple, reliable Firestore data processor based on your working implementation
 * Focuses on the core functionality without over-engineering
 */
class DataProcessor {
  /**
   * Sanitizes data for Firestore storage with depth protection
   */
  sanitizeForFirestore(data: any, options?: { maxDepth?: number }): any {
    const maxDepth = options?.maxDepth || 50; // Prevent infinite recursion
    return this.sanitizeRecursive(data, 0, maxDepth);
  }

  /**
   * Recursive sanitization with depth protection
   */
  private sanitizeRecursive(data: any, depth: number, maxDepth: number): any {
    return transformSanitize(data, depth, maxDepth);
  }

  /**
   * Restores data from Firestore - converts Timestamps back to Dates with depth protection
   */
  restoreFromFirestore(data: any, options?: { maxDepth?: number }): any {
    const maxDepth = options?.maxDepth || 50; // Prevent infinite recursion
    return this.restoreRecursive(data, 0, maxDepth);
  }

  /**
   * Recursive restoration with depth protection
   */
  private restoreRecursive(data: any, depth: number, maxDepth: number): any {
    return transformRestore(data, depth, maxDepth);
  }

  /**
   * Simple field name sanitization for Firestore compatibility
   */
  sanitizeFieldName(fieldName: string): string {
    return sanitizeFieldName(fieldName);
  }

  /**
   * Enhanced validation that catches the 20,000 field limit
   */
  validateForFirestore(data: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
      checkForCircularReferences(data);
      checkBasicConstraints(data, '', errors);

      // Check field count at the root level
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const fieldCount = Object.keys(data).length;
        if (fieldCount > 20000) {
          errors.push(`Document has ${fieldCount} fields, exceeds Firestore's 20,000 field limit`);
        }
      }

      // Check document size (approximate)
      const serialized = JSON.stringify(this.sanitizeForFirestore(data));
      const sizeInBytes = new Blob([serialized]).size;

      if (sizeInBytes > 1048576) { // 1MB limit
        errors.push(`Document size (~${Math.round(sizeInBytes / 1024)}KB) may exceed Firestore's 1MB limit`);
      }

    } catch (error) {
      errors.push(`Validation error: ${error}`);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Enhanced logInvalidFieldNames method for DataProcessor
   */
  logInvalidFieldNames(data: any, path = ''): string[] {
    const invalidFields = findInvalidFieldNames(data, path);
    invalidFields.forEach(fieldPath => {
      Log.error(`Invalid Firestore field name detected at path: '${fieldPath}'`);
    });
    return invalidFields;
  }

  /**
   * Test if your data survives a round trip (useful for debugging)
   */
  testRoundTrip(originalData: any): { success: boolean; message: string } {
    try {
      // Check for invalid dates first
      const hasInvalidDate = (data: any): boolean => {
        if (data instanceof Date && isNaN(data.getTime())) {
          return true;
        }
        if (Array.isArray(data)) {
          return data.some(item => hasInvalidDate(item));
        }
        if (data !== null && typeof data === 'object') {
          return Object.values(data).some(value => hasInvalidDate(value));
        }
        return false;
      };

      if (hasInvalidDate(originalData)) {
        return { success: false, message: 'Invalid date detected' };
      }

      // Use instance methods instead of helper functions directly
      const sanitized = this.sanitizeForFirestore(originalData);
      const restored = this.restoreFromFirestore(sanitized);

      // Simple comparison - you can enhance this if needed
      const dateReplacer = (_key: string, value: any) => {
        if (value instanceof Date) {
          return { __date: value.toISOString() };
        }
        return value;
      };

      const originalJson = JSON.stringify(originalData, dateReplacer);
      const restoredJson = JSON.stringify(restored, dateReplacer);

      if (originalJson === restoredJson) {
        return { success: true, message: 'Round trip successful' };
      } else {
        return { success: false, message: 'Data changed during round trip' };
      }
    } catch (error) {
      return { success: false, message: `Round trip failed: ${error}` };
    }
  }

  /**
   * Test specific data types that commonly cause issues
   */
  checkCommonIssues(data: any): string[] {
    return checkCommonIssues(data);
  }

  /**
   * Comprehensive data analysis to find Firestore issues
   */
  analyzeForFirestoreIssues(data: any, path = ''): {
    issues: string[];
    suspiciousValues: Array<{ path: string; value: any; type: string; issue: string }>;
    stats: {
      totalFields: number;
      maxDepth: number;
      arrayCount: number;
      objectCount: number;
      dateCount: number;
      nullCount: number;
      undefinedCount: number;
      functionCount: number;
      symbolCount: number;
    };
  } {
    return analyzeForFirestoreIssues(data, path);
  }
}

// Export both class and convenience functions
export default DataProcessor;

// Convenience functions that match your original API
export const sanitizeForFirestore = (data: any): any => {
  const processor = new DataProcessor();
  return processor.sanitizeForFirestore(data);
};

export const restoreFromFirestore = (data: any): any => {
  const processor = new DataProcessor();
  return processor.restoreFromFirestore(data);
};
