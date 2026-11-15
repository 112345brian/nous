// Characterization of the annotation/read merge rules against real SQLite and the real core schema.
import { createRealDb, type RealDb } from '../../services/__tests__/helpers/realSqlite';
import { mergeAnnotation as coreMerge } from '../../core/annotationMerge';
import { mergeRead } from '../../core/readsMerge';
import { CORE_MIGRATIONS } from '../../services/coreMigrations';
import { runMigrations, userVersionStore } from '../../core/migrations';

let db: RealDb;
let n = 0;
const mergeAnnotation = (d: any, a: any) => coreMerge(d, a, { clock: { now: () => 1234 }, newUid: () => 'u' + (++n).toString(16).padStart(31, '0') });
beforeEach(async () => {
  db = createRealDb();
  await runMigrations(db as any, CORE_MIGRATIONS, userVersionStore as any);
});
const anns = () => db.raw.prepare('SELECT * FROM annotations ORDER BY id').all();

describe('mergeAnnotation', () => {
  const base = { uid: 'u1', slug: 's', selected_text: 'txt', note: 'n1', created_at: 10, updated_at: 20 };
  it('rejects invalid input without writing', async () => {
    for (const bad of [null, {}, { slug: 's' }, { slug: '', selected_text: 'x' }, { slug: 's', selected_text: '' }] as any[]) {
      expect(await mergeAnnotation(db as any, bad)).toBe(false);
    }
    expect(anns()).toHaveLength(0);
  });
  it('inserts with default colour and keeps the given uid', async () => {
    expect(await mergeAnnotation(db as any, base)).toBe(true);
    expect(anns()[0]).toMatchObject({ uid: 'u1', color: '#FFE566', note: 'n1', created_at: 10, updated_at: 20 });
  });
  it('takes the uid from the injected source when none is given', async () => {
    await mergeAnnotation(db as any, { ...base, uid: undefined });
    expect(anns()[0].uid).toMatch(/^u0+1$/);
  });
  it('defaults missing timestamps (updated falls back to created)', async () => {
    await mergeAnnotation(db as any, { slug: 's', selected_text: 'a', created_at: 7 });
    expect(anns()[0]).toMatchObject({ created_at: 7, updated_at: 7 });
  });
  it('last writer wins by updated_at; a cleared note propagates; equal or older is skipped', async () => {
    await mergeAnnotation(db as any, base);
    expect(await mergeAnnotation(db as any, { ...base, note: null, updated_at: 30 })).toBe(true);
    expect(anns()[0].note).toBeNull();
    expect(await mergeAnnotation(db as any, { ...base, note: 'old', updated_at: 30 })).toBe(false);
    expect(await mergeAnnotation(db as any, { ...base, note: 'old', updated_at: 5 })).toBe(false);
    expect(anns()[0].note).toBeNull();
    expect(anns()).toHaveLength(1);
  });
  it('matches uid-less (v1) records by slug + text + created_at', async () => {
    await mergeAnnotation(db as any, { ...base, uid: undefined });
    expect(await mergeAnnotation(db as any, { ...base, uid: undefined, note: 'x', updated_at: 99 })).toBe(true);
    expect(anns()).toHaveLength(1);
  });
});

describe('mergeRead', () => {
  const r = { slug: 'a', visited_at: 5, session_id: 's' };
  it('rejects invalid reads', async () => {
    for (const bad of [null, {}, { ...r, slug: '' }, { ...r, visited_at: NaN }, { ...r, session_id: '' }] as any[]) {
      expect(await mergeRead(db as any, bad)).toBe(false);
    }
  });
  it('inserts once; the same identity is ignored; title falls back to slug', async () => {
    expect(await mergeRead(db as any, r)).toBe(true);
    expect(await mergeRead(db as any, { ...r, title: 'other' })).toBe(false);
    const rows = db.raw.prepare('SELECT * FROM reads').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('a');
  });
});
