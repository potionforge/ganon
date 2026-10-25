import { RemoteDigestEntry } from './RemoteDigestEntry';

interface MetadataStorage {
  [key: string]: RemoteDigestEntry;
}

export default MetadataStorage;