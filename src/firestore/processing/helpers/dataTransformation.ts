import { Timestamp } from '@react-native-firebase/firestore';
import { sanitizeFieldName } from './fieldNameValidation';

/**
 * Sanitizes data for Firestore storage with depth protection
 */
export const sanitizeForFirestore = (data: any, depth: number = 0, maxDepth: number = 50): any => {
  // Prevent infinite recursion
  if (depth > maxDepth) {
    return null;
  }

  if (Array.isArray(data)) {
    return data.map(item => sanitizeForFirestore(item, depth + 1, maxDepth));
  }

  if (data instanceof Date) {
    // Handle invalid dates
    if (isNaN(data.getTime())) {
      return null;
    }
    return Timestamp.fromDate(data);
  }

  // Don't double-convert existing Timestamps
  if (data && typeof data.toDate === 'function') {
    return data;
  }

  if (data !== null && typeof data === 'object') {
    const result: { [key: string]: any } = {};

    for (const [key, value] of Object.entries(data)) {
      // CRITICAL: Skip null/undefined keys to prevent native crashes
      if (key === null || key === undefined) {
        continue;
      }

      // Convert key to string and validate
      const stringKey = String(key);
      if (stringKey.length === 0) {
        continue;
      }

      // Skip undefined values (null is allowed)
      if (value === undefined) {
        continue;
      }

      // Skip functions and symbols
      if (typeof value === 'function' || typeof value === 'symbol') {
        continue;
      }

      // Sanitize field name if needed
      const sanitizedKey = sanitizeFieldName(stringKey);
      const sanitizedValue = sanitizeForFirestore(value, depth + 1, maxDepth);
      
      // Only include the field if it has valid content after sanitization
      if (sanitizedValue !== undefined) {
        if (sanitizedValue && typeof sanitizedValue === 'object' && !Array.isArray(sanitizedValue)) {
          // For nested objects, only include if they have valid content
          if (Object.keys(sanitizedValue).length > 0) {
            result[sanitizedKey] = sanitizedValue;
          }
        } else {
          result[sanitizedKey] = sanitizedValue;
        }
      }
    }

    return result;
  }

  return data;
};

/**
 * Restores data from Firestore - converts Timestamps back to Dates with depth protection
 */
export const restoreFromFirestore = (data: any, depth: number = 0, maxDepth: number = 50): any => {
  // Prevent infinite recursion
  if (depth > maxDepth) {
    return null;
  }

  if (Array.isArray(data)) {
    return data.map(item => restoreFromFirestore(item, depth + 1, maxDepth));
  }

  if (data instanceof Timestamp) {
    return data.toDate();
  }

  if (data !== null && typeof data === 'object') {
    const result: { [key: string]: any } = {};

    for (const [key, value] of Object.entries(data)) {
      result[key] = restoreFromFirestore(value, depth + 1, maxDepth);
    }

    return result;
  }

  return data;
};

/**
 * Tests if data survives a round trip through Firestore
 */
export const testRoundTrip = (originalData: any): { success: boolean; message: string } => {
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

    const sanitized = sanitizeForFirestore(originalData);
    const restored = restoreFromFirestore(sanitized);

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
}; 