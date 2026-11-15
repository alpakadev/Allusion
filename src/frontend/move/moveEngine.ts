/**
 * Safe file moving, independent of Allusion's stores and database.
 *
 * Guarantees:
 * - Never overwrites an existing file (throws MoveCollisionError instead).
 * - Moves across drives are done as copy -> verify (size + hash) -> rename into place -> delete original.
 *   The original is only deleted once a verified copy carries its final name.
 *
 * Keep this file free of imports from the rest of the app, so it can be unit tested and
 * survives upstream merges untouched.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as path from 'path';

/** Extension of the temporary file used while copying across drives. Not an image extension, so the folder watcher ignores it. */
export const PARTIAL_EXTENSION = '.allusion-partial';

export class MoveCollisionError extends Error {
  constructor(public readonly destination: string) {
    super(`A file already exists at "${destination}"`);
    this.name = 'MoveCollisionError';
  }
}

export class MoveVerificationError extends Error {
  constructor(public readonly source: string) {
    super(`The copy of "${source}" did not match the original. The original was left untouched.`);
    this.name = 'MoveVerificationError';
  }
}

export class MoveCancelledError extends Error {
  constructor() {
    super('The move was cancelled');
    this.name = 'MoveCancelledError';
  }
}

export interface MoveResult {
  /** Whether the move had to be done as copy + delete (different drive/volume) */
  crossDevice: boolean;
  /** The inode of the file at its destination */
  ino: string;
  /** False when the verified copy is in place but the original could not be deleted (e.g. locked by another program) */
  sourceRemoved: boolean;
}

export interface MoveOptions {
  /**
   * Only called for moves across drives: the verified copy exists, but does not have its final name yet.
   * Since the inode changes when crossing drives, this is the moment to tell the database about it,
   * before the folder watcher sees the file appear. If this throws, the move is aborted and the original stays.
   */
  onBeforeCommit?: (staged: { ino: string }) => Promise<void>;
  /** Aborts a copy across drives that is still running: the original stays where it is */
  signal?: AbortSignal;
  /** Reports how far a copy across drives is */
  onProgress?: (copiedBytes: number, totalBytes: number) => void;
  /** For testing: replaces the rename call that is attempted first */
  rename?: (src: string, dst: string) => Promise<void>;
}

export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Whether two files have the same content. Compares sizes first, so it is cheap for most non-duplicates. */
export async function areFilesIdentical(a: string, b: string): Promise<boolean> {
  const [statA, statB] = await Promise.all([fse.stat(a), fse.stat(b)]);
  if (statA.size !== statB.size) {
    return false;
  }
  const [hashA, hashB] = await Promise.all([hashFile(a), hashFile(b)]);
  return hashA === hashB;
}

/** Returns the given path if it is free, otherwise the first free variant: `name (1).ext`, `name (2).ext`, ... */
export async function findFreePath(filePath: string): Promise<string> {
  if (!(await fse.pathExists(filePath))) {
    return filePath;
  }
  const { dir, name, ext } = path.parse(filePath);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!(await fse.pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free file name for "${filePath}"`);
}

/**
 * Removes what an interrupted copy across drives left behind for this destination.
 * Returns how many files were removed.
 */
export async function removePartials(destination: string): Promise<number> {
  const dir = path.dirname(destination);
  const prefix = path.basename(destination) + '.';
  if (!(await fse.pathExists(dir))) {
    return 0;
  }
  let removed = 0;
  for (const name of await fse.readdir(dir)) {
    if (name.startsWith(prefix) && name.endsWith(PARTIAL_EXTENSION)) {
      await fse.remove(path.join(dir, name));
      removed++;
    }
  }
  return removed;
}

async function isSameFile(a: string, b: string): Promise<boolean> {
  const [statA, statB] = await Promise.all([
    fse.stat(a, { bigint: true }),
    fse.stat(b, { bigint: true }),
  ]);
  return statA.ino === statB.ino && statA.dev === statB.dev;
}

async function inoOf(filePath: string): Promise<string> {
  return (await fse.stat(filePath)).ino.toString();
}

/** Copies a file to a path that must not exist yet. Can be cancelled, and reports its progress. */
async function copyFile(src: string, dst: string, options: MoveOptions): Promise<void> {
  const { signal, onProgress } = options;
  const total = (await fse.stat(src)).size;
  await new Promise<void>((resolve, reject) => {
    const read = fs.createReadStream(src);
    const write = fs.createWriteStream(dst, { flags: 'wx' });
    let copied = 0;
    let isDone = false;
    const finish = (error?: Error) => {
      if (isDone) {
        return;
      }
      isDone = true;
      signal?.removeEventListener('abort', onAbort);
      if (error === undefined) {
        resolve();
        return;
      }
      read.destroy();
      // The file must be closed before the caller can remove what was copied so far
      if (write.destroyed) {
        setImmediate(() => reject(error));
      } else {
        write.once('close', () => reject(error));
        write.destroy();
      }
    };
    const onAbort = () => finish(new MoveCancelledError());
    read.on('data', (chunk) => {
      copied += chunk.length;
      onProgress?.(copied, total);
    });
    read.on('error', finish);
    write.on('error', finish);
    write.on('finish', () => finish());
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);
    read.pipe(write);
  });
}

export async function moveFileSafely(
  source: string,
  destination: string,
  options: MoveOptions = {},
): Promise<MoveResult> {
  const src = path.normalize(source);
  const dst = path.normalize(destination);
  if (src === dst) {
    throw new Error('Source and destination are the same');
  }
  if (!(await fse.pathExists(src))) {
    throw new Error(`"${src}" does not exist anymore`);
  }
  // On case-insensitive file systems, renaming "a.png" to "A.png" finds itself at the destination: that is fine.
  if ((await fse.pathExists(dst)) && !(await isSameFile(src, dst))) {
    throw new MoveCollisionError(dst);
  }
  await fse.ensureDir(path.dirname(dst));

  try {
    await (options.rename ?? fse.rename)(src, dst);
    return { crossDevice: false, ino: await inoOf(dst), sourceRemoved: true };
  } catch (e: any) {
    if (e?.code !== 'EXDEV') {
      throw e;
    }
  }

  // Different drive: copy under a temporary name, verify, and only then give it its final name
  const partial = `${dst}.${crypto.randomBytes(4).toString('hex')}${PARTIAL_EXTENSION}`;
  try {
    await copyFile(src, partial, options);
    if (!(await areFilesIdentical(src, partial))) {
      throw new MoveVerificationError(src);
    }
    // Keep the modified date, Allusion uses it to detect whether a file was overwritten
    const srcStats = await fse.stat(src);
    await fse.utimes(partial, srcStats.atime, srcStats.mtime);

    if (options.signal?.aborted) {
      throw new MoveCancelledError();
    }
    await options.onBeforeCommit?.({ ino: await inoOf(partial) });

    if (await fse.pathExists(dst)) {
      throw new MoveCollisionError(dst);
    }
    await fse.rename(partial, dst);
  } catch (e) {
    await fse.remove(partial).catch(() => undefined);
    throw e;
  }

  let sourceRemoved = true;
  try {
    await fse.unlink(src);
  } catch (e) {
    console.error('Moved file was copied and verified, but the original could not be deleted', e);
    sourceRemoved = false;
  }
  return { crossDevice: true, ino: await inoOf(dst), sourceRemoved };
}
