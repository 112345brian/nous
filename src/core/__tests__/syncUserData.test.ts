// The core run with plain in-memory fakes: no jest.mock, no expo, no react-native.
import { exportUserDataToFolder, importUserDataFromFolder } from '../syncUserData';
import type { SyncFolder, UserDataStore } from '../ports';

interface Snap { version: number; n?: number }

function fakes(opts: { folder?: string; files?: Record<string, string>; writeFails?: boolean; env?: { platform: string; home: string } } = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const imported: Snap[] = [];
  const folder: SyncFolder = {
    read: async uri => files.get(uri) ?? null,
    write: async (uri, text) => { if (opts.writeFails) throw new Error('ro'); files.set(uri, text); },
  };
  const store: UserDataStore<Snap> = {
    getSyncFolder: async () => opts.folder ?? '/data',
    exportUserData: async () => ({ version: 1, n: 7 }),
    importUserData: async d => { imported.push(d); },
  };
  return { files, imported, deps: { folder, store, env: opts.env ?? { platform: 'android', home: '' } } };
}

describe('core never touches globals', () => {
  const realFetch = (globalThis as any).fetch;
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
    (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
  });
  afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

  test('export then import round-trips through the fakes', async () => {
    const f = fakes();
    expect(await exportUserDataToFolder(f.deps)).toBe('ok');
    expect([...f.files.keys()]).toEqual(['file:///data/sep_user.json']);
    expect(f.files.get('file:///data/sep_user.json')).toBe('{\n  "version": 1,\n  "n": 7\n}');
    expect(await importUserDataFromFolder(f.deps)).toBe('ok');
    expect(f.imported).toEqual([{ version: 1, n: 7 }]);
  });
});

describe('exportUserDataToFolder', () => {
  test('no folder set', async () => {
    const f = fakes({ folder: '  ' });
    expect(await exportUserDataToFolder(f.deps)).toBe('no_folder');
    expect(f.files.size).toBe(0);
  });
  test('a failing folder surfaces as error, not an exception', async () => {
    expect(await exportUserDataToFolder(fakes({ writeFails: true }).deps)).toBe('error');
  });
  test('the platform and home come from the injected env', async () => {
    const mac = fakes({ folder: '~/Sync', env: { platform: 'macos', home: '/Users/x' } });
    await exportUserDataToFolder(mac.deps);
    expect([...mac.files.keys()]).toEqual(['file:///Users/x/Sync/sep_user.json']);
    const droid = fakes({ folder: '~/Sync', env: { platform: 'android', home: '/Users/x' } });
    await exportUserDataToFolder(droid.deps);
    expect([...droid.files.keys()]).toEqual(['file://~/Sync/sep_user.json']);
  });
});

describe('importUserDataFromFolder', () => {
  const URI = 'file:///data/sep_user.json';
  test('no folder, not found', async () => {
    expect(await importUserDataFromFolder(fakes({ folder: '' }).deps)).toBe('no_folder');
    expect(await importUserDataFromFolder(fakes().deps)).toBe('not_found');
  });
  test('only version 1 is accepted; nothing is imported otherwise', async () => {
    for (const text of ['{"version":2}', 'null', '{bad', '[]', '""']) {
      const f = fakes({ files: { [URI]: text } });
      expect(await importUserDataFromFolder(f.deps)).toBe('error');
      expect(f.imported).toEqual([]);
    }
  });
  test('a store that rejects the import is reported as error', async () => {
    const f = fakes({ files: { [URI]: '{"version":1}' } });
    f.deps.store.importUserData = async () => { throw new Error('constraint'); };
    expect(await importUserDataFromFolder(f.deps)).toBe('error');
  });
});
