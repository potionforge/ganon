import { resolveGanonConfig } from '../../models/config/resolveGanonConfig';
import { MOCK_CLOUD_BACKUP_CONFIG } from '../../__mocks__/MockConfig';

describe('resolveGanonConfig', () => {
  it('defaults legacyMetadataWrites to true for mixed-fleet safety (step 6.1)', () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    expect(resolved.legacyMetadataWrites).toBe(true);
  });

  it('defaults digestReadMode to dual for mixed-fleet transition (step 6.1)', () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    expect(resolved.digestReadMode).toBe('dual');
  });

  it('allows explicit legacyMetadataWrites false for step 6.3 sunset', () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
      legacyMetadataWrites: false,
    });
    expect(resolved.legacyMetadataWrites).toBe(false);
  });
});
