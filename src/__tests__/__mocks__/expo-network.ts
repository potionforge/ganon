export interface NetworkState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  type: string;
}

export enum NetworkStateType {
  NONE = "NONE",
  UNKNOWN = "UNKNOWN",
  CELLULAR = "CELLULAR",
  WIFI = "WIFI",
  BLUETOOTH = "BLUETOOTH",
  ETHERNET = "ETHERNET",
  WIMAX = "WIMAX",
  VPN = "VPN",
  OTHER = "OTHER"
}

export async function getNetworkStateAsync(): Promise<NetworkState> {
  return {
    isConnected: true,
    isInternetReachable: true,
    type: NetworkStateType.WIFI
  };
}

export async function getIpAddressAsync(): Promise<string | null> {
  return '192.168.1.1';
}

export async function isAirplaneModeEnabledAsync(): Promise<boolean> {
  return false;
}

export async function getMacAddressAsync(): Promise<string | null> {
  return '00:00:00:00:00:00';
}

export async function getPermissionsAsync(): Promise<{ status: 'granted' | 'denied' | 'undetermined' }> {
  return { status: 'granted' };
}

export async function requestPermissionsAsync(): Promise<{ status: 'granted' | 'denied' | 'undetermined' }> {
  return { status: 'granted' };
} 