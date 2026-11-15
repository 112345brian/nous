// Adapter test: what "~" means on-device comes from expo-file-system, never process.env.
let mockDocument: { uri: string } | undefined | 'throw';
jest.mock('expo-file-system', () => ({
  File: class {},
  Directory: class {},
  Paths: {
    cache: 'file:///cache/',
    get document() {
      if (mockDocument === 'throw') throw new Error('unavailable');
      return mockDocument;
    },
  },
}));
import { expoSyncHome } from '../expoSyncFolder';
import { resolveSyncFileUri } from '../../utils/syncPath';

describe('expoSyncHome', () => {
  test('is the document directory without a trailing slash', () => {
    mockDocument = { uri: 'file:///var/mobile/App/Documents/' };
    expect(expoSyncHome()).toBe('file:///var/mobile/App/Documents');
  });
  test('ignores process.env.HOME', () => {
    const prev = process.env.HOME;
    process.env.HOME = '/nope';
    mockDocument = { uri: 'file:///docs' };
    expect(expoSyncHome()).toBe('file:///docs');
    process.env.HOME = prev;
  });
  test('is "" when the platform has no document directory (so ~ resolves to null)', () => {
    for (const d of [undefined, 'throw'] as const) {
      mockDocument = d;
      expect(expoSyncHome()).toBe('');
    }
    expect(resolveSyncFileUri('~/Sync', { platform: 'ios', home: expoSyncHome() })).toBeNull();
  });
  test('feeds ~/Sync into a valid file URI', () => {
    mockDocument = { uri: 'file:///docs/' };
    expect(resolveSyncFileUri('~/Sync', { platform: 'ios', home: expoSyncHome() })).toBe(
      'file:///docs/Sync/sep_user.json',
    );
  });
});
