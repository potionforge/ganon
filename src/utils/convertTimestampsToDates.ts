const convertTimestampsToDates = (data: any): any => {
  if (Array.isArray(data)) {
    return data.map(convertTimestampsToDates);
  } else if (data && typeof data === 'object' && typeof data.toDate === 'function') {
    return data.toDate(); // 🔥 Convert Firestore Timestamp back to JavaScript Date
  } else if (data !== null && typeof data === 'object') {
    return Object.entries(data).reduce((acc, [key, value]) => {
      acc[key] = convertTimestampsToDates(value);
      return acc;
    }, {} as { [key: string]: any });
  }
  return data;
};

export default convertTimestampsToDates;
