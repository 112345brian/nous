import { resolveSyncFileUri, USER_DATA_FILENAME } from '../syncPath';

const ios = { platform: 'ios', home: '/Users/me' };
describe('resolveSyncFileUri', () => {
  test('blank -> null', () => {
    expect(resolveSyncFileUri('', ios)).toBeNull();
    expect(resolveSyncFileUri('  \n', ios)).toBeNull();
  });
  test('adds scheme and trailing slash, trims, keeps file:// URIs', () => {
    expect(resolveSyncFileUri(' /a/b ', ios)).toBe(`file:///a/b/${USER_DATA_FILENAME}`);
    expect(resolveSyncFileUri('file:///a/b/', ios)).toBe(`file:///a/b/${USER_DATA_FILENAME}`);
  });
  test('~ expands only on ios/macos, using the injected home', () => {
    expect(resolveSyncFileUri('~/S', ios)).toBe('file:///Users/me/S/sep_user.json');
    expect(resolveSyncFileUri('~/S', { platform: 'macos', home: '/h' })).toBe('file:///h/S/sep_user.json');
    expect(resolveSyncFileUri('~/S', { platform: 'android', home: '/h' })).toBe('file://~/S/sep_user.json');
    // Unknown home: no folder rather than an invalid file://Sync/... URI.
    expect(resolveSyncFileUri('~', { platform: 'ios', home: '' })).toBeNull();
    expect(resolveSyncFileUri('~/Sync', { platform: 'ios', home: '' })).toBeNull();
  });
  test('~ forms: bare, ~/Sync, home with and without trailing slash, file:// home', () => {
    const doc = 'file:///var/mobile/App/Documents';
    for (const home of [doc, doc + '/', doc + '//']) {
      const env = { platform: 'ios', home };
      expect(resolveSyncFileUri('~/Sync', env)).toBe(`${doc}/Sync/sep_user.json`);
      expect(resolveSyncFileUri('~', env)).toBe(`${doc}/sep_user.json`);
      expect(resolveSyncFileUri('~/', env)).toBe(`${doc}/sep_user.json`);
    }
  });
  test('a path without ~ ignores home; ~user is not expanded', () => {
    const env = { platform: 'ios', home: 'file:///h' };
    expect(resolveSyncFileUri('/a/~/b', env)).toBe('file:///a/~/b/sep_user.json');
    expect(resolveSyncFileUri('~bob/x', env)).toBe('file://~bob/x/sep_user.json');
  });
});
