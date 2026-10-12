import { LocalStorageDrafts } from './draft-store';

describe('LocalStorageDrafts', () => {
  beforeEach(() => localStorage.clear());

  it('stores, lists and removes drafts', () => {
    const drafts = new LocalStorageDrafts(localStorage);
    drafts.write({ pageId: 'p1', baseRevision: 3, doc: { type: 'doc' }, savedAt: 'now' });
    expect(drafts.read('p1')?.baseRevision).toBe(3);
    expect(drafts.list().map((d) => d.pageId)).toEqual(['p1']);
    drafts.remove('p1');
    expect(drafts.read('p1')).toBeNull();
  });

  it('ignores corrupted entries', () => {
    localStorage.setItem('notatnik.draft.p2', '{not json');
    localStorage.setItem(
      'notatnik.draft.p3',
      JSON.stringify({ pageId: 'other', baseRevision: 1, doc: { type: 'doc' } }),
    );
    const drafts = new LocalStorageDrafts(localStorage);
    expect(drafts.read('p2')).toBeNull();
    expect(drafts.read('p3')).toBeNull();
  });
});
