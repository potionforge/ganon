import { useMemo } from "react";
import Ganon from "../Ganon";
import { GanonConfig } from "../models/config/GanonConfig";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";

export function useGanon<T extends Record<string, any> & BaseStorageMapping>(config: GanonConfig<T>): Ganon<T> {
  return useMemo(() => new Ganon<T>(config), [config]);
}
