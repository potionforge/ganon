import { reconstructChunkedData } from '../../firestore/chunking/helpers/chunkReconstruction';

function snapshotFromChunks(chunks: Array<{ id: string; data: Record<string, unknown> | null }>) {
  return {
    docs: chunks.map(({ id, data }) => ({
      id,
      data: () => data,
    })),
  } as any;
}

describe('reconstructChunkedData', () => {
  it('kindHint array: empty chunk payload → []', () => {
    const snap = snapshotFromChunks([{ id: 'chunk_0', data: {} }]);
    expect(reconstructChunkedData(snap, 'array')).toEqual([]);
  });

  it('kindHint array: lone _empty sentinel → []', () => {
    const snap = snapshotFromChunks([{ id: 'chunk_0', data: { _empty: true } }]);
    expect(reconstructChunkedData(snap, 'array')).toEqual([]);
  });

  it('kindHint object: lone _empty sentinel → {}', () => {
    const snap = snapshotFromChunks([{ id: 'chunk_0', data: { _empty: true } }]);
    expect(reconstructChunkedData(snap, 'object')).toEqual({});
  });

  it('no hint: contiguous numeric keys → array (legacy heuristic)', () => {
    const snap = snapshotFromChunks([{ id: 'chunk_0', data: { '0': 'x', '1': 'y' } }]);
    expect(reconstructChunkedData(snap)).toEqual(['x', 'y']);
  });

  it('kindHint object: numeric keys stay object', () => {
    const snap = snapshotFromChunks([{ id: 'chunk_0', data: { '0': 'x', '1': 'y' } }]);
    expect(reconstructChunkedData(snap, 'object')).toEqual({ '0': 'x', '1': 'y' });
  });
});
