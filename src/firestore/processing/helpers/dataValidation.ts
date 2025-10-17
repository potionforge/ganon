import { isInvalidFieldName } from './fieldNameValidation';

/**
 * Checks for circular references in a data structure
 */
export const checkForCircularReferences = (data: any, seen = new WeakSet()): void => {
  if (data === null || typeof data !== 'object') {
    return;
  }

  if (seen.has(data)) {
    throw new Error('Circular reference detected');
  }

  seen.add(data);

  if (Array.isArray(data)) {
    data.forEach(item => checkForCircularReferences(item, seen));
  } else {
    Object.values(data).forEach(value => checkForCircularReferences(value, seen));
  }

  seen.delete(data);
};

/**
 * Checks basic constraints on data for Firestore compatibility
 */
export const checkBasicConstraints = (data: any, path: string, errors: string[], depth = 0): void => {
  if (depth > 50) {
    errors.push(`Deep nesting detected at ${path}`);
    return;
  }

  if (Array.isArray(data)) {
    if (data.length > 20000) {
      errors.push(`Array at ${path} has ${data.length} elements, exceeds Firestore limit of 20,000`);
    }
    data.forEach((item, index) => {
      checkBasicConstraints(item, `${path}[${index}]`, errors, depth + 1);
    });
  } else if (data instanceof Date) {
    const year = data.getFullYear();
    if (year < 1 || year > 10000) {
      errors.push(`Date at ${path} has invalid year: ${year}`);
    }
  } else if (typeof data === 'string' && data.length > 1000000) {
    errors.push(`String at ${path} is too large (${data.length} chars)`);
  } else if (data !== null && typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.length > 20000) {
      errors.push(`Object at ${path} has ${keys.length} fields, exceeds Firestore limit of 20,000`);
    }
    keys.forEach(key => {
      checkBasicConstraints(data[key], `${path}.${key}`, errors, depth + 1);
    });
  }
};

/**
 * Analyzes data for Firestore compatibility issues
 */
export const analyzeForFirestoreIssues = (data: any, path = ''): {
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
} => {
  const issues: string[] = [];
  const suspiciousValues: Array<{ path: string; value: any; type: string; issue: string }> = [];
  const stats = {
    totalFields: 0,
    maxDepth: 0,
    arrayCount: 0,
    objectCount: 0,
    dateCount: 0,
    nullCount: 0,
    undefinedCount: 0,
    functionCount: 0,
    symbolCount: 0
  };

  const analyze = (obj: any, currentPath: string, depth: number) => {
    stats.maxDepth = Math.max(stats.maxDepth, depth);

    if (depth > 20) {
      issues.push(`Excessive nesting depth (${depth}) at ${currentPath}`);
      return;
    }

    if (obj === null) {
      stats.nullCount++;
      return;
    }

    if (obj === undefined) {
      stats.undefinedCount++;
      suspiciousValues.push({
        path: currentPath,
        value: obj,
        type: 'undefined',
        issue: 'Undefined values are not allowed in Firestore'
      });
      return;
    }

    if (typeof obj === 'function') {
      stats.functionCount++;
      suspiciousValues.push({
        path: currentPath,
        value: obj.toString().substring(0, 100),
        type: 'function',
        issue: 'Functions are not allowed in Firestore'
      });
      return;
    }

    if (typeof obj === 'symbol') {
      stats.symbolCount++;
      suspiciousValues.push({
        path: currentPath,
        value: obj.toString(),
        type: 'symbol',
        issue: 'Symbols are not allowed in Firestore'
      });
      return;
    }

    if (obj instanceof Date) {
      stats.dateCount++;
      if (isNaN(obj.getTime())) {
        suspiciousValues.push({
          path: currentPath,
          value: obj,
          type: 'invalid-date',
          issue: 'Invalid Date object'
        });
      }

      const year = obj.getFullYear();
      if (year < 1 || year > 10000) {
        suspiciousValues.push({
          path: currentPath,
          value: obj,
          type: 'out-of-range-date',
          issue: `Date year ${year} is outside Firestore's supported range (1-10000)`
        });
      }
      return;
    }

    if (typeof obj === 'number') {
      if (!isFinite(obj)) {
        suspiciousValues.push({
          path: currentPath,
          value: obj,
          type: 'invalid-number',
          issue: 'Non-finite numbers (NaN, Infinity) are not allowed'
        });
      }

      if (Math.abs(obj) > Number.MAX_SAFE_INTEGER) {
        suspiciousValues.push({
          path: currentPath,
          value: obj,
          type: 'unsafe-number',
          issue: 'Number exceeds safe integer range'
        });
      }
      return;
    }

    if (typeof obj === 'string') {
      if (obj.length > 1048487) {
        suspiciousValues.push({
          path: currentPath,
          value: `${obj.substring(0, 100)}... (${obj.length} chars)`,
          type: 'oversized-string',
          issue: 'String exceeds Firestore limit of ~1MB'
        });
      }

      if (obj.includes('\x00')) {
        suspiciousValues.push({
          path: currentPath,
          value: obj,
          type: 'null-byte-string',
          issue: 'String contains null bytes'
        });
      }

      if (/[\uFFFE\uFFFF]/.test(obj)) {
        suspiciousValues.push({
          path: currentPath,
          value: obj,
          type: 'invalid-unicode',
          issue: 'String contains invalid Unicode characters'
        });
      }
      return;
    }

    if (Array.isArray(obj)) {
      stats.arrayCount++;

      if (obj.length > 20000) {
        issues.push(`Array at ${currentPath} has ${obj.length} elements, exceeds Firestore limit`);
      }

      obj.forEach((item, index) => {
        stats.totalFields++;
        analyze(item, `${currentPath}[${index}]`, depth + 1);
      });
      return;
    }

    if (typeof obj === 'object') {
      stats.objectCount++;

      try {
        JSON.stringify(obj);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'message' in error && 
            typeof (error as any).message === 'string' && 
            (error as any).message.includes('circular')) {
          suspiciousValues.push({
            path: currentPath,
            value: '[Circular Reference]',
            type: 'circular-reference',
            issue: 'Circular reference detected'
          });
          return;
        }
      }

      const keys = Object.keys(obj);

      if (keys.length > 20000) {
        issues.push(`Object at ${currentPath} has ${keys.length} fields, exceeds Firestore limit`);
      }

      for (const key of keys) {
        stats.totalFields++;

        if (!key || typeof key !== 'string') {
          suspiciousValues.push({
            path: currentPath,
            value: key,
            type: 'invalid-field-name',
            issue: 'Field name is not a valid string'
          });
          continue;
        }

        if (isInvalidFieldName(key)) {
          suspiciousValues.push({
            path: `${currentPath}.${key}`,
            value: key,
            type: 'invalid-field-name',
            issue: 'Field name violates Firestore naming rules'
          });
        }

        const childPath = currentPath ? `${currentPath}.${key}` : key;
        analyze(obj[key], childPath, depth + 1);
      }
    }
  };

  analyze(data, path, 0);
  return { issues, suspiciousValues, stats };
};

/**
 * Checks for common issues in data that might cause Firestore problems
 */
export const checkCommonIssues = (data: any): string[] => {
  const issues: string[] = [];

  try {
    const serialized = JSON.stringify(data);

    if (serialized.includes('BigInt')) {
      issues.push('Data contains BigInt values which are not supported');
    }

    const sizeBytes = new TextEncoder().encode(serialized).length;
    if (sizeBytes > 1048576) {
      issues.push(`Document size (${Math.round(sizeBytes/1024)}KB) exceeds Firestore 1MB limit`);
    }

  } catch (error) {
    if (typeof error === 'object' && error !== null && 'message' in error && 
        typeof (error as any).message === 'string') {
      issues.push(`JSON serialization failed: ${(error as any).message}`);
    } else {
      issues.push('JSON serialization failed: Unknown error');
    }
  }

  return issues;
}; 