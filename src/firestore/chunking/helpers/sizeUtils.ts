import Log from "../../../utils/Log";

/**
 * Calculates approximate size of data in bytes
 * @param data - The data to measure
 */
export function calculateDataSize(data: any): number {
  try {
    const serialized = JSON.stringify(data);
    return new Blob([serialized]).size;
  } catch (error) {
    // Fallback for data that can't be JSON serialized
    Log.warn(`SizeUtils: Could not calculate exact size, using approximation: ${error}`);
    return JSON.stringify(data).length * 2; // Rough estimate
  }
}