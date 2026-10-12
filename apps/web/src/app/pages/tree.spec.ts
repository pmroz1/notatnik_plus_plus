import { PageSummary } from '../core/api.types';
import {
  ancestorIds,
  buildTree,
  displayTitle,
  isSelfOrDescendant,
  moveTargetFor,
  siblingMove,
  trashRoots,
  visibleRows,
} from './tree';

let order = 0;
function page(id: string, parentId: string | null, extra: Partial<PageSummary> = {}): PageSummary {
  return {
    id,
    parentId,
    title: id.toUpperCase(),
    icon: null,
    sortOrder: order++,
    isFavorite: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastOpenedAt: null,
    deletedAt: null,
    deletedRootId: null,
    revision: 1,
    tags: [],
    ...extra,
  };
}

//  a
//  ├─ b
//  │  └─ c
//  └─ d
//  e
const pages = [page('a', null), page('b', 'a'), page('c', 'b'), page('d', 'a'), page('e', null)];

describe('tree helpers', () => {
  it('builds a nested tree in sort order and skips trashed pages', () => {
    const tree = buildTree([...pages, page('x', 'a', { deletedAt: '2026-01-02T00:00:00Z' })]);
    expect(tree.map((n) => n.page.id)).toEqual(['a', 'e']);
    expect(tree[0].children.map((n) => n.page.id)).toEqual(['b', 'd']);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it('shows pages with a missing parent at the top level and survives cycles', () => {
    const cyclic = [page('p', 'q'), page('q', 'p'), page('orphan', 'missing')];
    const tree = buildTree(cyclic);
    expect(tree.map((n) => n.page.id)).toEqual(['orphan']);
  });

  it('flattens only expanded branches', () => {
    const tree = buildTree(pages);
    expect(visibleRows(tree, new Set()).map((n) => n.page.id)).toEqual(['a', 'e']);
    expect(visibleRows(tree, new Set(['a'])).map((n) => n.page.id)).toEqual(['a', 'b', 'd', 'e']);
    expect(visibleRows(tree, new Set(['a', 'b'])).map((n) => n.page.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('computes ancestors and detects descendants', () => {
    expect(ancestorIds(pages, 'c')).toEqual(['b', 'a']);
    expect(isSelfOrDescendant(pages, 'a', 'c')).toBe(true);
    expect(isSelfOrDescendant(pages, 'a', 'a')).toBe(true);
    expect(isSelfOrDescendant(pages, 'c', 'a')).toBe(false);
  });

  it('translates drops into parent/index pairs and rejects cycles', () => {
    expect(moveTargetFor(pages, 'e', 'b', 'inside')).toEqual({ parentId: 'b', index: 1 });
    expect(moveTargetFor(pages, 'e', 'b', 'before')).toEqual({ parentId: 'a', index: 0 });
    expect(moveTargetFor(pages, 'e', 'b', 'after')).toEqual({ parentId: 'a', index: 1 });
    expect(moveTargetFor(pages, 'd', 'b', 'before')).toEqual({ parentId: 'a', index: 0 });
    expect(moveTargetFor(pages, 'a', 'c', 'inside')).toBeNull();
    expect(moveTargetFor(pages, 'a', 'c', 'after')).toBeNull();
    expect(moveTargetFor(pages, 'a', 'a', 'inside')).toBeNull();
  });

  it('supports keyboard/menu moves', () => {
    expect(siblingMove(pages, 'd', 'up')).toEqual({ parentId: 'a', index: 0 });
    expect(siblingMove(pages, 'b', 'up')).toBeNull();
    expect(siblingMove(pages, 'd', 'indent')).toEqual({ parentId: 'b', index: 1 });
    expect(siblingMove(pages, 'b', 'indent')).toBeNull();
    expect(siblingMove(pages, 'c', 'outdent')).toEqual({ parentId: 'a', index: 1 });
    expect(siblingMove(pages, 'a', 'outdent')).toBeNull();
    expect(siblingMove(pages, 'e', 'down')).toBeNull();
  });

  it('lists only directly deleted pages as trash entries', () => {
    const trashed = [
      page('t', null, { deletedAt: '2026-01-02T00:00:00Z', deletedRootId: 't' }),
      page('u', 't', { deletedAt: '2026-01-02T00:00:00Z', deletedRootId: 't' }),
    ];
    expect(trashRoots(trashed).map((p) => p.id)).toEqual(['t']);
  });

  it('uses a placeholder for empty titles', () => {
    expect(displayTitle({ title: '  ' })).toBe('Untitled');
  });
});
