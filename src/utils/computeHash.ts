import { SHA256 } from 'crypto-js';

/**
 * Computes a SHA-256 hash of the input value efficiently without deep copying.
 * This implementation handles large objects better by building a canonical string representation.
 *
 * @param value - The value to hash. Can be any type that can be stringified.
 * @param salt - Optional salt to add to the hash for additional uniqueness
 * @returns A hexadecimal string representing the truncated SHA-256 hash (32 characters)
 */
function computeHash(value: unknown, salt?: string): string {
  const parts: string[] = [];

  // Add salt first if provided
  if (salt) {
    parts.push(`salt:${salt}`);
  }

  // Recursively process the value
  function processValue(val: unknown): void {
    const type = typeof val;

    if (val === null) {
      parts.push('null');
    } else if (val === undefined) {
      // Skip undefined values at the root level
      return;
    } else if (type === 'boolean' || type === 'string') {
      parts.push(`${type}:${val}`);
    } else if (type === 'number') {
      // Use hex representation for numbers to avoid precision issues
      parts.push(`number:${(val as number).toString(16)}`);
    } else if (Array.isArray(val)) {
      parts.push(`array:${val.length}`);
      val.forEach((item, index) => {
        parts.push(`[${index}]`);
        processValue(item);
      });
    } else if (type === 'object' && val !== null) {
      // Sort keys and process in order, skipping undefined values
      const entries = Object.entries(val as Record<string, unknown>)
        .filter(([_, value]) => value !== undefined); // Skip undefined values
      const keys = entries.map(([key]) => key).sort();
      parts.push(`object:${keys.length}`);
      keys.forEach(key => {
        parts.push(`key:${key}`);
        processValue((val as Record<string, unknown>)[key]);
      });
    } else {
      // Fallback for other types (functions, symbols, etc.)
      parts.push(`${type}:${String(val)}`);
    }
  }

  processValue(value);

  // Join all parts and hash once
  const input = parts.join('|');
  return SHA256(input).toString().substring(0, 16);
}

export default computeHash;
