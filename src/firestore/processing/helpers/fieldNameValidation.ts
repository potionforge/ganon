/**
 * Helper functions for validating and sanitizing Firestore field names
 */

/**
 * Validates if a field name is valid for Firestore
 */
export const isInvalidFieldName = (fieldName: string): boolean => {
  if (!fieldName || typeof fieldName !== 'string') return true;
  if (fieldName.length === 0) return true;
  if (/^\./.test(fieldName) || /\.$/.test(fieldName)) return true;
  if (/[\/\[\]\*\.~\x00]/.test(fieldName)) return true;
  if (fieldName === '__name__') return true;
  if (/^__.*__$/.test(fieldName)) return true;
  if (fieldName.length > 1500) return true;
  if (/[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]/.test(fieldName)) return true;
  return false;
};

/**
 * Sanitizes a field name for Firestore compatibility
 */
export const sanitizeFieldName = (fieldName: string): string => {
  if (!fieldName) {
    return 'invalid_field';
  }

  // First handle leading dots
  let sanitized = fieldName.replace(/^\.+/, '');

  // Then replace other problematic characters with underscores
  sanitized = sanitized.replace(/[\/\[\]\*\.]/g, '_');

  // Handle reserved patterns
  if (sanitized === '__name__') {
    sanitized = '__name___safe';
  } else if (sanitized.startsWith('__') && sanitized.endsWith('__')) {
    sanitized = `_${sanitized.slice(2, -2)}_safe`;
  }

  // If the field name becomes empty after sanitization, return a default
  return sanitized || 'invalid_field';
};

/**
 * Finds all invalid field names in a data structure
 */
export const findInvalidFieldNames = (data: any, path = ''): string[] => {
  const invalidFields: string[] = [];

  if (Array.isArray(data)) {
    data.forEach((item, idx) => {
      invalidFields.push(...findInvalidFieldNames(item, `${path}[${idx}]`));
    });
  } else if (data !== null && typeof data === 'object' && !(data instanceof Date) && typeof data.toDate !== 'function') {
    for (const [key, value] of Object.entries(data)) {
      if (isInvalidFieldName(key)) {
        const fieldPath = path ? `${path}.${key}` : key;
        invalidFields.push(fieldPath);
      }

      // Continue validation recursively
      const childPath = path ? `${path}.${key}` : key;
      invalidFields.push(...findInvalidFieldNames(value, childPath));
    }
  }

  return invalidFields;
};
