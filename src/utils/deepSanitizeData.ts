import { Timestamp } from '@react-native-firebase/firestore';

const deepSanitizeData = (data: any): any => {
  if (Array.isArray(data)) {
    return data.map(deepSanitizeData);
  } else if (data instanceof Date) {
    return Timestamp.fromDate(data); // 🔥 Convert Date to Firestore Timestamp
  } else if (data !== null && typeof data === 'object') {
    return Object.entries(data).reduce((acc, [key, value]) => {
      if (value !== undefined && typeof value !== 'function' && typeof value !== 'symbol') {
        acc[key] = deepSanitizeData(value);
      }
      return acc;
    }, {} as { [key: string]: any });
  }
  return data;
};

export default deepSanitizeData;
