import { DocNode } from '../core/api.types';
import { MemoryDrafts } from './draft-store';
import { PageSaveController, SaveFn, SaveOutcome } from './page-save-controller';

const OPTIONS = { debounceMs: 700, retryDelaysMs: [1000, 2000], draftDelayMs: 100 };

function doc(text: string): DocNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

interface Call {
  doc: DocNode;
  expected: number;
  resolve: (o: SaveOutcome) => void;
}

/** A save function whose responses are resolved manually by the test. */
function manualSave(): { fn: SaveFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: SaveFn = (_id, d, expected) =>
    new Promise<SaveOutcome>((resolve) =>
      calls.push({ doc: structuredClone(d), expected, resolve }),
    );
  return { fn, calls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('PageSaveController', () => {
  let drafts: MemoryDrafts;
  let current: DocNode;

  beforeEach(() => {
    vi.useFakeTimers();
    drafts = new MemoryDrafts();
    current = doc('');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function make(save: SaveFn, revision = 1): PageSaveController {
    const c = new PageSaveController('page-1', revision, save, drafts, OPTIONS);
    c.attachSource(() => current);
    return c;
  }

  function type(c: PageSaveController, text: string): void {
    current = doc(text);
    c.markDirty();
  }

  it('debounces rapid typing into a single save with the latest content', async () => {
    const { fn, calls } = manualSave();
    const c = make(fn);
    for (const t of ['h', 'he', 'hel', 'hell', 'hello']) {
      type(c, t);
      vi.advanceTimersByTime(200);
    }
    expect(c.status()).toBe('unsaved');
    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(700);
    expect(calls.length).toBe(1);
    expect(calls[0].doc).toEqual(doc('hello'));
    expect(calls[0].expected).toBe(1);
    expect(c.status()).toBe('saving');
    calls[0].resolve({ kind: 'ok', revision: 2 });
    await settle();
    expect(c.status()).toBe('saved');
    expect(c.currentRevision).toBe(2);
  });

  it('serializes saves and sends edits made during a save with the new revision', async () => {
    const { fn, calls } = manualSave();
    const c = make(fn);
    type(c, 'one');
    vi.advanceTimersByTime(700);
    expect(calls.length).toBe(1);
    type(c, 'one two');
    vi.advanceTimersByTime(5000);
    // Still only one request in flight.
    expect(calls.length).toBe(1);
    calls[0].resolve({ kind: 'ok', revision: 2 });
    await settle();
    // Not "saved": newer edits are pending.
    expect(c.status()).toBe('unsaved');
    vi.advanceTimersByTime(700);
    expect(calls.length).toBe(2);
    expect(calls[1].expected).toBe(2);
    expect(calls[1].doc).toEqual(doc('one two'));
    calls[1].resolve({ kind: 'ok', revision: 3 });
    await settle();
    expect(c.status()).toBe('saved');
  });

  it('keeps a recovery draft until the server acknowledges the save', async () => {
    const { fn, calls } = manualSave();
    const c = make(fn);
    type(c, 'draft text');
    vi.advanceTimersByTime(100);
    expect(drafts.read('page-1')?.doc).toEqual(doc('draft text'));
    vi.advanceTimersByTime(600);
    calls[0].resolve({ kind: 'ok', revision: 2 });
    await settle();
    expect(drafts.read('page-1')).toBeNull();
  });

  it('retries transient failures with backoff and never reports saved early', async () => {
    const { fn, calls } = manualSave();
    const c = make(fn);
    type(c, 'x');
    vi.advanceTimersByTime(700);
    calls[0].resolve({ kind: 'error', transient: true, message: 'offline' });
    await settle();
    expect(c.status()).toBe('error');
    expect(c.errorMessage()).toContain('retrying in 1s');
    expect(drafts.read('page-1')?.doc).toEqual(doc('x'));
    vi.advanceTimersByTime(999);
    expect(calls.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(calls.length).toBe(2);
    calls[1].resolve({ kind: 'error', transient: true, message: 'offline' });
    await settle();
    vi.advanceTimersByTime(2000);
    expect(calls.length).toBe(3);
    calls[2].resolve({ kind: 'error', transient: true, message: 'offline' });
    await settle();
    // Retries exhausted: stays failed until the user retries.
    vi.advanceTimersByTime(60_000);
    expect(calls.length).toBe(3);
    expect(c.status()).toBe('error');
    c.retryNow();
    vi.advanceTimersByTime(0);
    expect(calls.length).toBe(4);
    calls[3].resolve({ kind: 'ok', revision: 2 });
    await settle();
    expect(c.status()).toBe('saved');
  });

  it('does not auto-retry permanent failures', async () => {
    const { fn, calls } = manualSave();
    const c = make(fn);
    type(c, 'x');
    vi.advanceTimersByTime(700);
    calls[0].resolve({ kind: 'error', transient: false, message: 'Session expired' });
    await settle();
    vi.advanceTimersByTime(60_000);
    expect(calls.length).toBe(1);
    expect(c.status()).toBe('error');
    expect(c.errorMessage()).toBe('Session expired');
  });

  it('stops autosaving on conflict until the user explicitly overwrites', async () => {
    const { fn, calls } = manualSave();
    const c = make(fn);
    type(c, 'mine');
    vi.advanceTimersByTime(700);
    calls[0].resolve({ kind: 'conflict', currentRevision: 5 });
    await settle();
    expect(c.status()).toBe('conflict');
    expect(c.conflictRevision()).toBe(5);
    expect(drafts.read('page-1')?.doc).toEqual(doc('mine'));
    type(c, 'mine, edited');
    vi.advanceTimersByTime(10_000);
    expect(calls.length).toBe(1);
    expect(await c.flush()).toBe(false);
    expect(c.status()).toBe('conflict');

    c.overwriteRemote(5);
    vi.advanceTimersByTime(0);
    expect(calls.length).toBe(2);
    expect(calls[1].expected).toBe(5);
    expect(calls[1].doc).toEqual(doc('mine, edited'));
    calls[1].resolve({ kind: 'ok', revision: 6 });
    await settle();
    expect(c.status()).toBe('saved');
  });

  it('flush saves immediately and waits for the in-flight request', async () => {
    let revision = 1;
    const saved: DocNode[] = [];
    const fn: SaveFn = async (_id, d) => {
      saved.push(structuredClone(d));
      return { kind: 'ok', revision: ++revision };
    };
    const c = make(fn);
    type(c, 'quick');
    const done = c.flush();
    expect(await done).toBe(true);
    expect(saved).toEqual([doc('quick')]);
    expect(c.status()).toBe('saved');
  });

  it('keeps saving the last snapshot after the editor is detached (navigation)', async () => {
    const { fn, calls } = manualSave();
    const c = make(fn);
    type(c, 'before navigation');
    c.detachSource();
    current = doc('something else entirely');
    const flushed = c.flush();
    expect(calls.length).toBe(1);
    expect(calls[0].doc).toEqual(doc('before navigation'));
    calls[0].resolve({ kind: 'ok', revision: 2 });
    expect(await flushed).toBe(true);
  });

  it('a late response never resets a newer unsaved state to saved', async () => {
    const { fn, calls } = manualSave();
    const c = make(fn);
    type(c, 'a');
    vi.advanceTimersByTime(700);
    type(c, 'ab');
    calls[0].resolve({ kind: 'ok', revision: 2 });
    await settle();
    expect(c.status()).toBe('unsaved');
    expect(c.hasUnsavedChanges()).toBe(true);
  });

  it('dispose keeps the recovery draft, discard removes it', () => {
    const { fn } = manualSave();
    const c = make(fn);
    type(c, 'pending');
    c.dispose();
    expect(drafts.read('page-1')?.doc).toEqual(doc('pending'));
    c.discardLocalChanges();
    expect(drafts.read('page-1')).toBeNull();
  });
});
