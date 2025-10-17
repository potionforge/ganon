import { Timestamp } from '@react-native-firebase/firestore';
import DataProcessor, { sanitizeForFirestore, restoreFromFirestore } from '../processing/DataProcessor';

// Mock Firebase Timestamp
jest.mock('@react-native-firebase/firestore', () => {
  class MockTimestamp {
    private date: Date;

    constructor(date: Date) {
      this.date = date;
    }

    toDate() {
      return this.date;
    }

    toISOString() {
      return this.date.toISOString();
    }

    isEqual(other: MockTimestamp) {
      return this.date.getTime() === other.date.getTime();
    }

    static fromDate(date: Date) {
      return new MockTimestamp(date);
    }
  }

  return {
    Timestamp: MockTimestamp
  };
});

describe('DataProcessor', () => {
  let processor: DataProcessor;

  beforeEach(() => {
    processor = new DataProcessor();
  });

  describe('sanitizeForFirestore', () => {
    it('should convert Date objects to Timestamps', () => {
      const date = new Date('2024-03-20T12:00:00Z');
      const result = processor.sanitizeForFirestore(date);
      expect(result).toBeInstanceOf(Timestamp);
      expect(result.toDate().toISOString()).toBe(date.toISOString());
    });

    it('should handle depth limits', () => {
      // Create a deeply nested object
      let deep: any = {};
      let current = deep;
      for (let i = 0; i < 60; i++) {
        current.nested = {};
        current = current.nested;
      }
      
      // Should truncate at depth limit - the nested object at depth 10 should be null
      const result = processor.sanitizeForFirestore(deep, { maxDepth: 10 });
      expect(result).not.toBeNull();
      expect(result.nested).not.toBeNull();
      
      // Check that at depth 11, the nested object is null (depth 10 is the last valid level)
      let currentResult = result;
      for (let i = 0; i < 11; i++) {
        currentResult = currentResult.nested;
      }
      expect(currentResult).toBeNull();
    });

    it('should allow custom depth limits', () => {
      const nested = { level1: { level2: { level3: { value: 'test' } } } };
      
      // Should work with custom depth limit
      const result = processor.sanitizeForFirestore(nested, { maxDepth: 5 });
      expect(result.level1.level2.level3.value).toBe('test');
    });

    it('should handle large objects without size limits', () => {
      // Create a large object (over 500KB)
      const largeObject: any = {};
      for (let i = 0; i < 10000; i++) {
        largeObject[`key${i}`] = `value${i}`.repeat(100); // ~1MB total
      }
      
      // Should not throw size limit error
      expect(() => processor.sanitizeForFirestore(largeObject)).not.toThrow();
    });

    it('should handle invalid dates by converting to null', () => {
      const invalidDate = new Date('invalid');
      const result = processor.sanitizeForFirestore(invalidDate);
      expect(result).toBeNull();
    });

    it('should not convert existing Timestamps', () => {
      const timestamp = Timestamp.fromDate(new Date());
      const result = processor.sanitizeForFirestore(timestamp);
      expect(result).toBe(timestamp);
    });

    it('should handle arrays', () => {
      const input = [new Date('2024-03-20'), { date: new Date('2024-03-21') }];
      const result = processor.sanitizeForFirestore(input);
      expect(result[0]).toBeInstanceOf(Timestamp);
      expect(result[1].date).toBeInstanceOf(Timestamp);
    });

    it('should handle nested objects', () => {
      const input = {
        date: new Date('2024-03-20'),
        nested: {
          date: new Date('2024-03-21')
        }
      };
      const result = processor.sanitizeForFirestore(input);
      expect(result.date).toBeInstanceOf(Timestamp);
      expect(result.nested.date).toBeInstanceOf(Timestamp);
    });

    it('should sanitize field names', () => {
      const input = {
        'invalid/field': 'value',
        '__name__': 'value',
        '.__dot': 'value',
        'normal.field': 'value'
      };
      const result = processor.sanitizeForFirestore(input);
      expect(result['invalid_field']).toBe('value');
      expect(result['__name___safe']).toBe('value');
      expect(result['__dot']).toBe('value');
      expect(result['normal_field']).toBe('value');
    });

    it('should skip undefined, functions, and symbols', () => {
      const input = {
        undefined: undefined,
        func: () => {},
        symbol: Symbol('test'),
        valid: 'value'
      };
      const result = processor.sanitizeForFirestore(input);
      expect(result).toEqual({ valid: 'value' });
    });

    it('should not double-convert existing Timestamps', () => {
      const mockTimestamp = Object.create(Timestamp.prototype);
      mockTimestamp.toDate = jest.fn();

      const result = processor.sanitizeForFirestore(mockTimestamp);
      expect(result).toBe(mockTimestamp);
    });

    it('should handle arrays recursively', () => {
      const date = new Date('2023-01-01');
      const input = [1, 'string', date, { nested: date }];
      const result = processor.sanitizeForFirestore(input);

      expect(result).toHaveLength(4);
      expect(result[0]).toBe(1);
      expect(result[1]).toBe('string');
      expect(result[2].toDate()).toEqual(date);
      expect(result[3].nested.toDate()).toEqual(date);
    });

    it('should handle nested objects recursively', () => {
      const date = new Date('2023-01-01');
      const input = {
        level1: {
          level2: {
            date: date,
            array: [date, 'test']
          }
        }
      };
      const result = processor.sanitizeForFirestore(input);

      expect(result.level1.level2.date.toDate()).toEqual(date);
      expect(result.level1.level2.array[0].toDate()).toEqual(date);
      expect(result.level1.level2.array[1]).toBe('test');
    });

    it('should sanitize field names', () => {
      const input = {
        'field.with.dots': 'value1',
        'field/with/slashes': 'value2',
        'field[with]brackets': 'value3',
        'field*with*asterisk': 'value4'
      };
      const result = processor.sanitizeForFirestore(input);

      expect(result).toEqual({
        'field_with_dots': 'value1',
        'field_with_slashes': 'value2',
        'field_with_brackets': 'value3',
        'field_with_asterisk': 'value4'
      });
    });
  });

  describe('restoreFromFirestore', () => {
    it('should convert Timestamps back to Dates', () => {
      const timestamp = Timestamp.fromDate(new Date('2024-03-20T12:00:00Z'));
      const result = processor.restoreFromFirestore(timestamp);
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-03-20T12:00:00.000Z');
    });

    it('should handle depth limits', () => {
      // Create a deeply nested object
      let deep: any = {};
      let current = deep;
      for (let i = 0; i < 60; i++) {
        current.nested = {};
        current = current.nested;
      }
      
      // Should truncate at depth limit - the nested object at depth 10 should be null
      const result = processor.restoreFromFirestore(deep, { maxDepth: 10 });
      expect(result).not.toBeNull();
      expect(result.nested).not.toBeNull();
      
      // Check that at depth 11, the nested object is null (depth 10 is the last valid level)
      let currentResult = result;
      for (let i = 0; i < 11; i++) {
        currentResult = currentResult.nested;
      }
      expect(currentResult).toBeNull();
    });

    it('should allow custom depth limits', () => {
      const timestamp = Timestamp.fromDate(new Date('2024-03-20T12:00:00Z'));
      const nested = { 
        level1: { 
          level2: { 
            level3: { 
              timestamp 
            } 
          } 
        } 
      };
      
      // Should work with custom depth limit
      const result = processor.restoreFromFirestore(nested, { maxDepth: 5 });
      expect(result.level1.level2.level3.timestamp).toBeInstanceOf(Date);
    });

    it('should handle large objects without size limits', () => {
      // Create a large object (over 500KB)
      const largeObject: any = {};
      for (let i = 0; i < 10000; i++) {
        largeObject[`key${i}`] = `value${i}`.repeat(100); // ~1MB total
      }
      
      // Should not throw size limit error
      expect(() => processor.restoreFromFirestore(largeObject)).not.toThrow();
    });

    it('should handle arrays', () => {
      const input = [
        Timestamp.fromDate(new Date('2024-03-20')),
        { date: Timestamp.fromDate(new Date('2024-03-21')) }
      ];
      const result = processor.restoreFromFirestore(input);
      expect(result[0]).toBeInstanceOf(Date);
      expect(result[1].date).toBeInstanceOf(Date);
    });

    it('should handle nested objects', () => {
      const input = {
        date: Timestamp.fromDate(new Date('2024-03-20')),
        nested: {
          date: Timestamp.fromDate(new Date('2024-03-21'))
        }
      };
      const result = processor.restoreFromFirestore(input);
      expect(result.date).toBeInstanceOf(Date);
      expect(result.nested.date).toBeInstanceOf(Date);
    });
  });

  describe('validateForFirestore', () => {
    it('should validate valid data', () => {
      const input = { name: 'test', date: new Date() };
      const result = processor.validateForFirestore(input);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect circular references', () => {
      const circular: any = { name: 'test' };
      circular.self = circular;
      const result = processor.validateForFirestore(circular);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Circular reference detected');
    });

    it('should detect deep nesting', () => {
      let deep: any = {};
      let current = deep;
      for (let i = 0; i < 51; i++) {
        current.nested = {};
        current = current.nested;
      }
      const result = processor.validateForFirestore(deep);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Deep nesting detected');
    });

    it('should detect large arrays', () => {
      const largeArray = new Array(20001).fill(0);
      const result = processor.validateForFirestore(largeArray);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('exceeds Firestore limit of 20,000');
    });

    it('should detect large objects', () => {
      const largeObject: any = {};
      for (let i = 0; i < 20001; i++) {
        largeObject[`key${i}`] = i;
      }
      const result = processor.validateForFirestore(largeObject);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('exceeds Firestore limit of 20,000');
    });
  });

  describe('testRoundTrip', () => {
    it('should successfully round trip simple data', () => {
      const input = {
        name: 'test',
        date: new Date('2024-03-20T12:00:00Z'),
        numbers: [1, 2, 3],
        nested: {
          date: new Date('2024-03-21T12:00:00Z')
        }
      };
      const result = processor.testRoundTrip(input);
      expect(result.success).toBe(true);
      expect(result.message).toBe('Round trip successful');
    });

    it('should fail round trip with invalid data', () => {
      const input = {
        date: new Date('invalid')
      };
      const result = processor.testRoundTrip(input);
      expect(result.success).toBe(false);
    });
  });

  describe('convenience functions', () => {
    it('should provide working convenience functions', () => {
      const date = new Date('2024-03-20T12:00:00Z');

      const sanitized = sanitizeForFirestore(date);
      expect(sanitized).toBeInstanceOf(Timestamp);

      const restored = restoreFromFirestore(sanitized);
      expect(restored).toBeInstanceOf(Date);
      expect(restored.toISOString()).toBe(date.toISOString());
    });
  });
});
