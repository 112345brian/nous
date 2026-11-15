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
    // Pinned existing behaviour (not endorsed): with no known home the result is not a valid
    // file URI. React Native's process.env usually has no HOME, so this may be the common case
    // on a real device; see docs/core-di-audit.md.
    expect(resolveSyncFileUri('~', { platform: 'ios', home: '' })).toBe('file://sep_user.json');
  });
});
