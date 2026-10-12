import { PageSummary } from '../core/api.types';

export interface TreeNode {
  page: PageSummary;
  children: TreeNode[];
  depth: number;
}

/** Builds the live page tree. Pages whose parent is missing are shown at the top level. */
export function buildTree(pages: readonly PageSummary[]): TreeNode[] {
  const live = pages.filter((p) => !p.deletedAt);
  const ids = new Set(live.map((p) => p.id));
  const byParent = new Map<string | null, PageSummary[]>();
  for (const p of live) {
    const key = p.parentId && ids.has(p.parentId) ? p.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(p);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }
  const visited = new Set<string>();
  const build = (parentId: string | null, depth: number): TreeNode[] =>
    (byParent.get(parentId) ?? [])
      .filter((p) => !visited.has(p.id) && visited.add(p.id))
      .map((page) => ({ page, depth, children: build(page.id, depth + 1) }));
  return build(null, 0);
}

/** Flattens the tree into visible rows, honouring the expanded set. */
export function visibleRows(nodes: TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const rows: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      rows.push(node);
      if (node.children.length && expanded.has(node.page.id)) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return rows;
}

/** Ancestor ids of a page, nearest first. Stops on cycles or missing parents. */
export function ancestorIds(pages: readonly PageSummary[], id: string): string[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id)?.parentId ?? null;
  while (current && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return result;
}

/** True if `candidate` is `id` itself or inside its subtree (moving there would be a cycle). */
export function isSelfOrDescendant(
  pages: readonly PageSummary[],
  id: string,
  candidate: string,
): boolean {
  return candidate === id || ancestorIds(pages, candidate).includes(id);
}

/** Trash entries: pages that were deleted directly (not together with an ancestor). */
export function trashRoots(pages: readonly PageSummary[]): PageSummary[] {
  return pages
    .filter((p) => p.deletedAt && p.deletedRootId === p.id)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

export function displayTitle(page: Pick<PageSummary, 'title'>): string {
  return page.title.trim() || 'Untitled';
}

/** Live children of `parentId` (null = top level), in display order. */
export function liveChildren(pages: readonly PageSummary[], parentId: string | null): PageSummary[] {
  return pages
    .filter((p) => !p.deletedAt && p.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

export type DropPosition = 'before' | 'after' | 'inside';

export interface MoveTarget {
  parentId: string | null;
  /** Index among the new siblings, excluding the moved page (server semantics). */
  index: number;
}

/**
 * Translates a drop on `targetId` into the parent/index pair expected by the move API.
 * Returns null for moves that would create a cycle or are no-ops.
 */
export function moveTargetFor(
  pages: readonly PageSummary[],
  movedId: string,
  targetId: string,
  position: DropPosition,
): MoveTarget | null {
  const target = pages.find((p) => p.id === targetId);
  if (!target || movedId === targetId) {
    return null;
  }
  if (position === 'inside') {
    if (isSelfOrDescendant(pages, movedId, targetId)) {
      return null;
    }
    const siblings = liveChildren(pages, targetId).filter((p) => p.id !== movedId);
    return { parentId: targetId, index: siblings.length };
  }
  const parentId = target.parentId;
  if (parentId && isSelfOrDescendant(pages, movedId, parentId)) {
    return null;
  }
  const siblings = liveChildren(pages, parentId).filter((p) => p.id !== movedId);
  const at = siblings.findIndex((p) => p.id === targetId);
  return { parentId, index: position === 'before' ? at : at + 1 };
}

/** Keyboard/menu move helpers. Each returns null when the move is not possible. */
export function siblingMove(
  pages: readonly PageSummary[],
  id: string,
  direction: 'up' | 'down' | 'indent' | 'outdent',
): MoveTarget | null {
  const page = pages.find((p) => p.id === id);
  if (!page) {
    return null;
  }
  const siblings = liveChildren(pages, page.parentId);
  const at = siblings.findIndex((p) => p.id === id);
  switch (direction) {
    case 'up':
      return at > 0 ? { parentId: page.parentId, index: at - 1 } : null;
    case 'down':
      return at < siblings.length - 1 ? { parentId: page.parentId, index: at + 1 } : null;
    case 'indent': {
      const prev = siblings[at - 1];
      return prev ? { parentId: prev.id, index: liveChildren(pages, prev.id).length } : null;
    }
    case 'outdent': {
      if (!page.parentId) {
        return null;
      }
      const parent = pages.find((p) => p.id === page.parentId);
      if (!parent) {
        return null;
      }
      const parentSiblings = liveChildren(pages, parent.parentId);
      return { parentId: parent.parentId, index: parentSiblings.findIndex((p) => p.id === parent.id) + 1 };
    }
  }
}
