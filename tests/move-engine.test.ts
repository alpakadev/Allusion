import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import {
  areFilesIdentical,
  findFreePath,
  MoveCollisionError,
  moveFileSafely,
  PARTIAL_EXTENSION,
  MoveCancelledError,
} from '../src/frontend/move/moveEngine';
import { fuzzyScore } from '../src/frontend/move/fuzzy';
import { MoveBatch, MoveJournal } from '../src/frontend/move/MoveJournal';

const exdev = async () => {
  throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
};

describe('move engine', () => {
  let dir: string;
  let src: string;
  let dstDir: string;

  beforeEach(async () => {
    dir = await fse.mkdtemp(path.join(os.tmpdir(), 'allusion-move-test-'));
    src = path.join(dir, 'source', 'a.png');
    dstDir = path.join(dir, 'dest');
    await fse.outputFile(src, 'image-content');
  });

  afterEach(() => fse.remove(dir));

  it('moves a file on the same drive', async () => {
    const dst = path.join(dstDir, 'a.png');
    const res = await moveFileSafely(src, dst);
    expect(res).toMatchObject({ crossDevice: false, sourceRemoved: true });
    expect(await fse.pathExists(src)).toBe(false);
    expect(await fse.readFile(dst, 'utf8')).toBe('image-content');
  });

  it('never overwrites an existing file', async () => {
    const dst = path.join(dstDir, 'a.png');
    await fse.outputFile(dst, 'other');
    await expect(moveFileSafely(src, dst)).rejects.toBeInstanceOf(MoveCollisionError);
    expect(await fse.readFile(src, 'utf8')).toBe('image-content');
    expect(await fse.readFile(dst, 'utf8')).toBe('other');
  });

  it('copies, verifies and deletes when crossing drives', async () => {
    const dst = path.join(dstDir, 'a.png');
    const mtime = (await fse.stat(src)).mtime;
    let stagedIno: string | undefined;
    const res = await moveFileSafely(src, dst, {
      rename: exdev,
      onBeforeCommit: async ({ ino }) => {
        stagedIno = ino;
        // At this point the original must still exist, and the final name must not
        expect(await fse.pathExists(src)).toBe(true);
        expect(await fse.pathExists(dst)).toBe(false);
      },
    });
    expect(res).toMatchObject({ crossDevice: true, sourceRemoved: true });
    expect(res.ino).toBe(stagedIno);
    expect(await fse.pathExists(src)).toBe(false);
    expect(await fse.readFile(dst, 'utf8')).toBe('image-content');
    expect((await fse.stat(dst)).mtime.getTime()).toBe(mtime.getTime());
    expect(await fse.readdir(dstDir)).toEqual(['a.png']);
  });

  it('keeps the original when a cross-drive move is aborted', async () => {
    const dst = path.join(dstDir, 'a.png');
    await expect(
      moveFileSafely(src, dst, {
        rename: exdev,
        onBeforeCommit: async () => {
          throw new Error('database unavailable');
        },
      }),
    ).rejects.toThrow('database unavailable');
    expect(await fse.readFile(src, 'utf8')).toBe('image-content');
    const leftovers = (await fse.readdir(dstDir)).filter((f) => f.endsWith(PARTIAL_EXTENSION));
    expect(leftovers).toEqual([]);
    expect(await fse.pathExists(dst)).toBe(false);
  });

  it('finds a free file name', async () => {
    expect(await findFreePath(src)).toBe(path.join(dir, 'source', 'a (1).png'));
    await fse.outputFile(path.join(dir, 'source', 'a (1).png'), 'x');
    expect(await findFreePath(src)).toBe(path.join(dir, 'source', 'a (2).png'));
    expect(await findFreePath(path.join(dir, 'free.png'))).toBe(path.join(dir, 'free.png'));
  });

  it('detects identical files', async () => {
    const same = path.join(dir, 'same.png');
    const sameSize = path.join(dir, 'same-size.png');
    await fse.outputFile(same, 'image-content');
    await fse.outputFile(sameSize, 'image-CONTENT');
    expect(await areFilesIdentical(src, same)).toBe(true);
    expect(await areFilesIdentical(src, sameSize)).toBe(false);
  });
});

describe('move journal', () => {
  let dir: string;
  const batch = (id: string): MoveBatch => ({
    id,
    date: 0,
    destination: 'dest',
    records: [{ fileId: id, from: 'a', to: 'b' }],
    undone: false,
  });

  beforeEach(async () => {
    dir = await fse.mkdtemp(path.join(os.tmpdir(), 'allusion-journal-test-'));
  });
  afterEach(() => fse.remove(dir));

  it('undoes newest first, redoes oldest first, and persists', async () => {
    const file = path.join(dir, 'history.json');
    const journal = new MoveJournal(file);
    await journal.push(batch('1'));
    await journal.push(batch('2'));
    await journal.push(batch('3'));

    expect(journal.nextUndo?.id).toBe('3');
    await journal.setUndone(journal.nextUndo!, true);
    await journal.setUndone(journal.nextUndo!, true);
    expect(journal.nextUndo?.id).toBe('1');
    expect(journal.nextRedo?.id).toBe('2');

    const reloaded = new MoveJournal(file);
    await reloaded.load();
    expect(reloaded.nextRedo?.id).toBe('2');

    // A new move discards what could have been redone
    await reloaded.push(batch('4'));
    expect(reloaded.nextRedo).toBeUndefined();
    expect(reloaded.batches.map((b) => b.id)).toEqual(['1', '4']);
  });
});

describe('fuzzy folder matching', () => {
  const folders = ['00-Landscapes', '02-Maps', '02-Posters', '05-Other-Assets', '50-Patterns'];
  const best = (q: string) =>
    folders
      .map((f) => [f, fuzzyScore(q, f)] as const)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f);

  it('prefers matches at the start of a word', () => {
    expect(best('pos')[0]).toBe('02-Posters');
    expect(best('pa')[0]).toBe('50-Patterns');
    expect(best('02')).toEqual(['02-Maps', '02-Posters']);
  });
  it('matches letters in order and rejects the rest', () => {
    expect(best('lds')).toEqual(['00-Landscapes']);
    expect(best('xyz')).toEqual([]);
  });
});

describe('cancelling a move across drives', () => {
  it('keeps the original and leaves nothing behind', async () => {
    const os = await import('os');
    const dir = await fse.mkdtemp(path.join(os.tmpdir(), 'move-cancel-'));
    const src = path.join(dir, 'a.png');
    const dst = path.join(dir, 'target', 'a.png');
    await fse.writeFile(src, Buffer.alloc(4 * 1024 * 1024, 7));
    const abort = new AbortController();
    const progress: number[] = [];
    await expect(
      moveFileSafely(src, dst, {
        rename: async () => {
          throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
        },
        signal: abort.signal,
        onProgress: (copied) => {
          progress.push(copied);
          abort.abort();
        },
      }),
    ).rejects.toBeInstanceOf(MoveCancelledError);
    expect(progress.length).toBeGreaterThan(0);
    expect(await fse.pathExists(src)).toBe(true);
    expect(await fse.readdir(path.join(dir, 'target'))).toEqual([]);
    await fse.remove(dir);
  });
});
