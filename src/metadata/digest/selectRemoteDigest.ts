import Log from '../../utils/Log';

export type DigestReadMode = 'legacy' | 'dual' | 'v2';

export interface DigestEntry {
  d: string;
  v: number;
}

/**
 * Selects the authoritative remote digest for a key based on read mode.
 * Dual mode: higher version wins; equal version prefers in-document (mixed-fleet tie-break).
 */
export function selectRemoteDigest(
  legacy: DigestEntry | undefined,
  inDocument: DigestEntry | undefined,
  mode: DigestReadMode
): DigestEntry | undefined {
  if (mode === 'legacy') {
    return legacy ?? inDocument;
  }
  if (mode === 'v2') {
    return inDocument ?? legacy;
  }

  if (!legacy && !inDocument) return undefined;
  if (!legacy) return inDocument;
  if (!inDocument) return legacy;
  if (inDocument.v > legacy.v) return inDocument;
  if (legacy.v > inDocument.v) return legacy;
  if (legacy.d !== inDocument.d) {
    Log.warn(
      `Ganon: selectRemoteDigest equal version ${legacy.v} with mismatched digests (legacy=${legacy.d}, inDocument=${inDocument.d}); preferring in-document`
    );
  }
  return inDocument;
}
