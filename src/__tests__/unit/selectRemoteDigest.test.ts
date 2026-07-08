import { selectRemoteDigest } from '../../metadata/digest/selectRemoteDigest';
import Log from '../../utils/Log';

jest.mock('../../utils/Log');

describe('selectRemoteDigest', () => {
  const legacy = { d: 'legacy-digest', v: 1 };
  const inDoc = { d: 'indoc-digest', v: 2 };

  it('legacy mode prefers legacy map', () => {
    expect(selectRemoteDigest(legacy, inDoc, 'legacy')).toEqual(legacy);
  });

  it('v2 mode prefers in-document digest', () => {
    expect(selectRemoteDigest(legacy, inDoc, 'v2')).toEqual(inDoc);
  });

  it('dual mode picks higher version (legacy wins when old client wrote after new client)', () => {
    expect(selectRemoteDigest(legacy, inDoc, 'dual')).toEqual(inDoc);
    expect(selectRemoteDigest({ d: 'a', v: 3 }, { d: 'b', v: 2 }, 'dual')).toEqual({
      d: 'a',
      v: 3,
    });
    // Transition window: new client wrote in-document v=5; old client updated legacy-only to v=10
    expect(
      selectRemoteDigest(
        { d: 'old-client-digest', v: 10 },
        { d: 'new-client-digest', v: 5 },
        'dual'
      )
    ).toEqual({ d: 'old-client-digest', v: 10 });
  });

  it('dual mode tie-break prefers in-document', () => {
    expect(
      selectRemoteDigest({ d: 'legacy', v: 5 }, { d: 'indoc', v: 5 }, 'dual')
    ).toEqual({ d: 'indoc', v: 5 });
  });

  it('dual mode equal version with mismatched digests warns and prefers in-document', () => {
    jest.mocked(Log.warn).mockClear();
    expect(
      selectRemoteDigest({ d: 'legacy', v: 5 }, { d: 'indoc', v: 5 }, 'dual')
    ).toEqual({ d: 'indoc', v: 5 });
    expect(Log.warn).toHaveBeenCalledWith(
      'Ganon: selectRemoteDigest equal version 5 with mismatched digests (legacy=legacy, inDocument=indoc); preferring in-document'
    );
  });

  it('falls back when only one source exists', () => {
    expect(selectRemoteDigest(undefined, inDoc, 'dual')).toEqual(inDoc);
    expect(selectRemoteDigest(legacy, undefined, 'dual')).toEqual(legacy);
  });
});
