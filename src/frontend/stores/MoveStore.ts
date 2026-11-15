import fse from 'fs-extra';
import { action, makeObservable, observable, runInAction } from 'mobx';
import path from 'path';

import { humanFileSize } from 'common/fmt';
import { DataStorage } from 'src/api/data-storage';
import { FileDTO } from 'src/api/file';
import { generateId, ID } from 'src/api/id';
import { RendererMessenger } from 'src/ipc/renderer';
import { AppToaster } from '../components/Toaster';
import { ClientFile, mergeMovedFile } from '../entities/File';
import { ClientLocation } from '../entities/Location';
import {
  areFilesIdentical,
  findFreePath,
  MoveCancelledError,
  moveFileSafely,
  removePartials,
} from '../move/moveEngine';
import { MoveBatch, MoveJournal, MoveRecord } from '../move/MoveJournal';
import RootStore from './RootStore';

const TOAST_KEY = 'move-files';
const JOURNAL_FILE_NAME = 'move-history.json';
const STORAGE_KEY = 'move-preferences';
/** Written while files are being moved, so an interrupted move can be tidied up at the next start */
const PENDING_FILE_NAME = 'move-pending.json';
/** Deleted files that can still be brought back */
const TRASH_FILE_NAME = 'move-trash.json';
/** Deleted files keep this extension until they really go to the recycle bin. The folder watcher ignores it. */
const TRASH_EXTENSION = '.allusion-trash';
/** How long a deleted file can be brought back with Undo */
const TRASH_UNDO_TIME = 5 * 60 * 1000;

type TrashItem = { fileId: ID; original: string; staged: string };

type PendingMove = {
  destination: string;
  done: MoveRecord[];
  current?: MoveRecord;
  /** An undo or redo: the history knows these files already */
  isReplay?: boolean;
};
/** How long the folder watcher ignores a file that was just moved here by this store */
const RECENT_MOVE_TIME = 15000;

export interface MoveOptions {
  /** Select the next file afterwards. Defaults to true in the full-size view. */
  advance?: boolean;
}

type CollisionChoice = 'rename' | 'skip' | 'replace' | 'cancel';

const comparablePath = (p: string) => {
  const normalized = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const plural = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/**
 * Moves files on disk while keeping Allusion's database in sync, with undo/redo.
 * Every way of moving files (drag and drop, context menu, hotkeys) should go through this store.
 *
 * Instead of waiting for the folder watcher to notice a moved file (which loses track of files
 * that cross drives, since their inode changes), the database entry is updated here directly.
 */
class MoveStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;
  private journal?: MoveJournal;
  private pendingPath?: string;
  private trashPath?: string;
  private pendingTrash: TrashItem[] = [];
  private pendingTrashDate = 0;
  private trashTimer?: number;

  /** Oldest first. Batches with `undone: true` can be redone. */
  readonly history = observable<MoveBatch>([]);
  @observable isMoving = false;
  /** The folder files were last moved into */
  @observable lastDestination: string | undefined = undefined;
  /**
   * When a file with the same name exists in the destination: ask what to do,
   * instead of keeping both by giving the moved file a new name.
   */
  @observable askOnCollision = false;
  /**
   * Files that were moved while they are shown in the gallery: file id -> name of the folder.
   * They stay where they are in the gallery (greyed out) so the arrangement does not change
   * while sorting, until the view is loaded anew.
   */
  readonly movedMarks = observable.map<ID, string>();
  /** Paths files were just moved to, with the time of the move */
  private readonly recentMoves = new Map<string, number>();

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;
    makeObservable(this);
    try {
      const prefs = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      this.askOnCollision = Boolean(prefs?.askOnCollision);
    } catch (e) {
      console.error('Could not restore move preferences', e);
    }
  }

  @action.bound toggleAskOnCollision(): void {
    this.askOnCollision = !this.askOnCollision;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ askOnCollision: this.askOnCollision }));
  }

  /**
   * The position of the next file in the gallery (delta 1) or the previous one (delta -1)
   * that was not moved, so the greyed out files are skipped when going through the files.
   * Stays where it is when there is none.
   */
  stepIndex(from: number, delta: number): number {
    const { fileList } = this.rootStore.fileStore;
    for (let i = from + delta; i >= 0 && i < fileList.length; i += delta) {
      const file = fileList[i] as ClientFile | undefined;
      if (file && !this.movedMarks.has(file.id)) {
        return i;
      }
    }
    return from;
  }

  @action.bound clearMovedMarks(): void {
    if (this.movedMarks.size > 0) {
      this.movedMarks.clear();
    }
    // The gallery is loaded anew: deleted files are gone for good from here on
    if (this.pendingTrash.length > 0) {
      this.finalizeTrash().then(() => {
        // They may have been loaded again while they were still in the library
        if (runInAction(() => !this.rootStore.uiStore.isSlideMode)) {
          this.rootStore.fileStore.debouncedRefetch();
        }
      }, console.error);
    }
  }

  /**
   * Whether this store moved a file to this path a moment ago. The folder watcher uses this
   * to not reload the gallery for changes that are already known.
   */
  isRecentMove(absolutePath: string): boolean {
    const now = Date.now();
    for (const [key, time] of this.recentMoves) {
      if (now - time > RECENT_MOVE_TIME) {
        this.recentMoves.delete(key);
      }
    }
    return this.recentMoves.has(comparablePath(absolutePath));
  }

  async init(): Promise<void> {
    const userData = await RendererMessenger.getPath('userData');
    this.journal = new MoveJournal(path.join(userData, JOURNAL_FILE_NAME));
    await this.journal.load();
    this.syncHistory();
    this.pendingPath = path.join(userData, PENDING_FILE_NAME);
    await this.recover().catch((e) => console.error('Could not recover interrupted move', e));
    // Files that were deleted before Allusion was closed: finish deleting them
    this.trashPath = path.join(userData, TRASH_FILE_NAME);
    try {
      if (await fse.pathExists(this.trashPath)) {
        const items = await fse.readJSON(this.trashPath);
        this.pendingTrash = Array.isArray(items) ? items : [];
        await this.finalizeTrash();
      }
    } catch (e) {
      console.error('Could not finish deleting files', e);
    }
  }

  private async writePending(pending: PendingMove): Promise<void> {
    if (this.pendingPath) {
      await fse.outputJSON(this.pendingPath, pending).catch(console.error);
    }
  }

  private async clearPending(): Promise<void> {
    if (this.pendingPath) {
      await fse.remove(this.pendingPath).catch(console.error);
    }
  }

  /** Makes the library entry of a file point to where the file was moved to */
  private async repairEntry(record: MoveRecord): Promise<void> {
    const dto = (await this.backend.fetchFilesByID([record.fileId])).at(0);
    const location = this.findLocation(record.to);
    if (
      dto === undefined ||
      location === undefined ||
      comparablePath(dto.absolutePath) === comparablePath(record.to)
    ) {
      return;
    }
    const stats = await fse.stat(record.to);
    const newData: FileDTO = {
      ...dto,
      absolutePath: record.to,
      relativePath: record.to.slice(location.path.length),
      locationId: location.id,
      ino: stats.ino.toString(),
      name: path.basename(record.to),
    };
    await this.backend.saveFiles([mergeMovedFile(dto, newData)]);
  }

  /**
   * Tidies up after a move that was interrupted, because Allusion was closed, crashed or froze:
   * - removes a half-finished copy; the original is still there in that case,
   * - finishes a move across drives whose verified copy is in place while the original remains,
   * - makes sure the library knows where the moved files are,
   * - adds the files that were moved to the history, so the move can be undone.
   */
  private async recover(): Promise<void> {
    if (!this.pendingPath || !(await fse.pathExists(this.pendingPath))) {
      return;
    }
    let pending: PendingMove;
    try {
      pending = await fse.readJSON(this.pendingPath);
    } catch (e) {
      await this.clearPending();
      return;
    }
    const done: MoveRecord[] = Array.isArray(pending.done) ? pending.done.slice() : [];
    const { current } = pending;
    let note = '';
    if (current) {
      try {
        await removePartials(current.to);
        const [hasSource, hasCopy] = await Promise.all([
          fse.pathExists(current.from),
          fse.pathExists(current.to),
        ]);
        if (hasSource && hasCopy) {
          // The copy was verified before it got its final name: only the original is left to remove
          if (await areFilesIdentical(current.from, current.to)) {
            await fse.unlink(current.from);
            done.push(current);
          } else {
            note = ` "${path.basename(current.from)}" now exists in both folders, please check it.`;
          }
        } else if (hasCopy) {
          done.push(current);
        } else if (!hasSource) {
          note = ` "${path.basename(current.from)}" could not be found anymore.`;
        }
      } catch (e) {
        console.error('Could not tidy up interrupted move', current, e);
      }
    }
    for (const record of done) {
      if (await fse.pathExists(record.to)) {
        await this.repairEntry(record).catch(console.error);
      }
    }
    if (done.length > 0 && typeof pending.destination === 'string' && !pending.isReplay) {
      await this.journal?.push({
        id: generateId(),
        date: Date.now(),
        destination: pending.destination,
        records: done,
        undone: false,
      });
      this.syncHistory();
    }
    await this.clearPending();
    if (done.length > 0 || note.length > 0) {
      AppToaster.show(
        {
          message: pending.isReplay
            ? `Allusion was closed during an undo or redo. Nothing was lost, but only a part of it was done: see History in the destination panel.${note}`
            : `Allusion was closed while moving files. ${plural(
                done.length,
              )} had been moved, nothing was lost.${note}`,
          timeout: 20000,
          type: 'warning',
          clickAction:
            done.length > 0 && !pending.isReplay
              ? { label: 'Undo', onClick: () => this.undo() }
              : undefined,
        },
        `${TOAST_KEY}-recovery`,
      );
      this.rootStore.fileStore.debouncedRefetch();
    }
  }

  @action private syncHistory() {
    this.history.replace(this.journal?.batches.map((b) => ({ ...b })) ?? []);
  }

  @action private setIsMoving(val: boolean) {
    this.isMoving = val;
  }

  /** Finds the Location a path lies in: files can only be moved to folders Allusion knows about */
  findLocation(targetPath: string): ClientLocation | undefined {
    const target = comparablePath(targetPath);
    return runInAction(() =>
      this.rootStore.locationStore.locationList
        .filter((loc) => {
          const locPath = comparablePath(loc.path);
          return target === locPath || target.startsWith(locPath + path.sep);
        })
        // In case of nested locations, pick the deepest one
        .sort((a, b) => b.path.length - a.path.length)
        .at(0),
    );
  }

  /** Whether a move is busy; shows a message if so */
  private isBusy(): boolean {
    const busy = runInAction(() => this.isMoving);
    if (busy) {
      AppToaster.show({ message: 'Still busy moving files...', timeout: 3000 }, TOAST_KEY);
    }
    return busy;
  }

  /**
   * Moves a single file on disk and updates its database entry (path, location, inode).
   * Tags and other properties are kept.
   */
  private async relocate(
    fileId: ID,
    expectedPath: string,
    dst: string,
    transfer: {
      signal?: AbortSignal;
      onProgress?: (copiedBytes: number, totalBytes: number) => void;
    } = {},
  ): Promise<boolean> {
    const { fileStore, uiStore } = this.rootStore;
    const loaded = runInAction(() => fileStore.get(fileId));
    const dto: FileDTO | undefined = loaded
      ? runInAction(() => loaded.serialize())
      : (await this.backend.fetchFilesByID([fileId]))[0];
    if (dto === undefined) {
      throw new Error('The file is not in the library anymore');
    }
    if (comparablePath(dto.absolutePath) !== comparablePath(expectedPath)) {
      throw new Error(`"${dto.name}" has been moved elsewhere in the meantime`);
    }
    const location = this.findLocation(dst);
    if (location === undefined) {
      throw new Error(`"${path.dirname(dst)}" is not part of any Location`);
    }

    const apply = async (data: Pick<FileDTO, 'absolutePath' | 'locationId' | 'ino'>) => {
      const loc = runInAction(() => this.rootStore.locationStore.get(data.locationId));
      const relativePath =
        loc && data.absolutePath.startsWith(loc.path)
          ? data.absolutePath.replace(loc.path, '')
          : data.absolutePath.slice(location.path.length);
      const newData: FileDTO = {
        ...dto,
        ...data,
        relativePath,
        name: path.basename(data.absolutePath),
      };
      const current = runInAction(() => fileStore.get(fileId));
      if (current) {
        runInAction(() => {
          uiStore.deselectFile(current);
          fileStore.replaceMovedFile(current, newData);
        });
      } else {
        await this.backend.saveFiles([mergeMovedFile(dto, newData)]);
      }
    };

    let applied = false;
    // Both ends of the move: the folder watcher reports the old path as removed, the new as added
    this.recentMoves.set(comparablePath(dst), Date.now());
    this.recentMoves.set(comparablePath(dto.absolutePath), Date.now());
    try {
      const result = await moveFileSafely(dto.absolutePath, dst, {
        ...transfer,
        // Across drives the inode changes: update the database before the file shows up under its
        // final name, otherwise the folder watcher would import it as a new, untagged file.
        onBeforeCommit: async ({ ino }) => {
          await apply({ absolutePath: dst, locationId: location.id, ino });
          applied = true;
        },
      });
      // A long copy may have outlasted the time the folder watcher ignores these paths:
      // its reports only arrive now, so the time starts again.
      this.recentMoves.set(comparablePath(dst), Date.now());
      this.recentMoves.set(comparablePath(dto.absolutePath), Date.now());
      if (!result.crossDevice) {
        await apply({ absolutePath: dst, locationId: location.id, ino: result.ino });
      }
      return result.sourceRemoved;
    } catch (e) {
      if (applied) {
        await apply({
          absolutePath: dto.absolutePath,
          locationId: dto.locationId,
          ino: dto.ino,
        }).catch(console.error);
      }
      throw e;
    }
  }

  private async askCollision(
    file: FileDTO,
    dst: string,
    showApplyToAll: boolean,
  ): Promise<{ choice: CollisionChoice; applyToAll: boolean }> {
    const [srcStats, dstStats, identical] = await Promise.all([
      fse.stat(file.absolutePath),
      fse.stat(dst),
      areFilesIdentical(file.absolutePath, dst).catch(() => false),
    ]);
    const describe = (label: string, dir: string, stats: fse.Stats) =>
      `${label}: ${dir}\n      ${humanFileSize(
        stats.size,
      )}, modified ${stats.mtime.toLocaleString()}`;
    const res = await RendererMessenger.showMessageBox({
      type: 'question',
      title: 'File already exists',
      message: `"${file.name}" already exists in "${path.basename(path.dirname(dst))}".`,
      detail: [
        identical
          ? 'Both files have exactly the same content (duplicate).'
          : 'The two files are different.',
        describe('Moving', path.dirname(file.absolutePath), srcStats),
        describe('Existing', path.dirname(dst), dstStats),
        'Replacing sends the existing file to the recycle bin and removes its tags.',
      ].join('\n\n'),
      buttons: ['Keep &both', '&Skip', '&Replace', '&Cancel'],
      normalizeAccessKeys: true,
      defaultId: identical ? 1 : 0,
      cancelId: 3,
      checkboxLabel: showApplyToAll ? 'Do this for all conflicts' : undefined,
    });
    const choices: CollisionChoice[] = ['rename', 'skip', 'replace', 'cancel'];
    return { choice: choices[res.response] ?? 'cancel', applyToAll: res.checkboxChecked };
  }

  /** Sends the file at this path to the recycle bin and removes it from the library */
  private async discardExisting(absolutePath: string): Promise<void> {
    const { fileStore } = this.rootStore;
    const target = comparablePath(absolutePath);
    const loaded = runInAction(() =>
      fileStore.definedFiles.find((f) => comparablePath(f.absolutePath) === target),
    );
    if (loaded) {
      await fileStore.deleteFiles([loaded]);
    } else {
      const matches = await this.backend.fetchFilesByKey('absolutePath', absolutePath);
      if (matches.length > 0) {
        await this.backend.removeFiles(matches.map((f) => f.id));
      }
    }
    const error = await RendererMessenger.trashFile(absolutePath);
    if (error) {
      throw error;
    }
  }

  /** Moves the given files into a folder. The folder must lie inside one of the Locations. */
  async moveFilesTo(
    files: ClientFile[],
    destinationDir: string,
    options: MoveOptions = {},
  ): Promise<void> {
    if (files.length === 0 || this.isBusy()) {
      return;
    }
    if (this.findLocation(destinationDir) === undefined) {
      AppToaster.show(
        {
          message: `"${destinationDir}" is not part of a Location. Add it as a Location first, so moved files stay in your library.`,
          timeout: 8000,
          type: 'warning',
        },
        TOAST_KEY,
      );
      return;
    }

    const dtos = runInAction(() => files.filter((f) => !f.isBroken).map((f) => f.serialize()));
    const destKey = comparablePath(destinationDir);
    const candidates = dtos.filter((f) => comparablePath(path.dirname(f.absolutePath)) !== destKey);
    if (candidates.length === 0) {
      return;
    }

    const { uiStore, fileStore } = this.rootStore;
    const advance = options.advance ?? runInAction(() => uiStore.isSlideMode);
    // The file to continue with: the first one after the moved files that is not sorted yet
    const nextFile = runInAction(() => {
      const ids = new Set(candidates.map((f) => f.id));
      const last = Math.max(-1, ...candidates.map((f) => fileStore.getIndex(f.id) ?? -1));
      if (!advance || last === -1) {
        return undefined;
      }
      for (let i = last + 1; i < fileStore.fileList.length; i++) {
        const f = fileStore.fileList[i] as ClientFile | undefined;
        if (f && !ids.has(f.id) && !this.movedMarks.has(f.id)) {
          return f;
        }
      }
      return undefined;
    });

    this.setIsMoving(true);
    const records: MoveRecord[] = [];
    const errors: string[] = [];
    let leftBehind = 0;
    let isCancelled = false;
    const abort = new AbortController();
    const started = Date.now();
    let lastShown = 0;
    // Moves that take a while show how far they are, and can be cancelled
    const showProgress = (index: number, name: string, fraction?: number) => {
      const now = Date.now();
      if (now - started < 700 || now - lastShown < 200) {
        return;
      }
      lastShown = now;
      const detail =
        fraction === undefined
          ? ''
          : fraction >= 1
          ? ' · checking the copy'
          : ` · ${Math.round(fraction * 100)}%`;
      AppToaster.show(
        {
          message: `Moving ${index + 1} / ${candidates.length} · ${name}${detail}`,
          timeout: 0,
          clickAction: { label: 'Cancel', onClick: () => abort.abort() },
        },
        TOAST_KEY,
      );
    };
    let renamed = 0;
    let duplicates = 0;
    let choiceForAll: CollisionChoice | undefined = runInAction(() =>
      this.askOnCollision ? undefined : 'rename',
    );
    try {
      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i];
        if (abort.signal.aborted) {
          isCancelled = true;
          break;
        }
        showProgress(i, file.name);
        let dst = path.join(destinationDir, file.name);
        try {
          if (await fse.pathExists(dst)) {
            let choice: CollisionChoice | undefined = choiceForAll;
            if (choice === undefined) {
              const answer = await this.askCollision(file, dst, candidates.length - i > 1);
              choice = answer.choice;
              if (answer.applyToAll && choice !== 'cancel') {
                choiceForAll = choice;
              }
            }
            if (choice === 'cancel') {
              break;
            } else if (choice === 'skip') {
              continue;
            } else if (choice === 'rename') {
              if (await areFilesIdentical(file.absolutePath, dst).catch(() => false)) {
                duplicates++;
              }
              dst = await findFreePath(dst);
              renamed++;
            } else {
              await this.discardExisting(dst);
            }
          }
          await this.writePending({
            destination: destinationDir,
            done: records,
            current: { fileId: file.id, from: file.absolutePath, to: dst },
          });
          const sourceRemoved = await this.relocate(file.id, file.absolutePath, dst, {
            signal: abort.signal,
            onProgress: (copied, total) =>
              showProgress(i, file.name, total > 0 ? copied / total : 1),
          });
          if (!sourceRemoved) {
            leftBehind++;
          }
          records.push({ fileId: file.id, from: file.absolutePath, to: dst });
          runInAction(() => this.movedMarks.set(file.id, path.basename(destinationDir)));
        } catch (e: any) {
          if (e instanceof MoveCancelledError) {
            isCancelled = true;
            break;
          }
          console.error('Could not move file', file.absolutePath, e);
          errors.push(e?.message ?? String(e));
        }
      }

      if (records.length > 0) {
        await this.journal?.push({
          id: generateId(),
          date: Date.now(),
          destination: destinationDir,
          records,
          undone: false,
        });
        this.syncHistory();
        runInAction(() => (this.lastDestination = destinationDir));
      }
    } finally {
      await this.clearPending();
      this.setIsMoving(false);
    }

    let message = `Moved ${plural(records.length)} → ${path.basename(destinationDir)}`;
    if (isCancelled) {
      // Files that were moved before cancelling stay moved: Undo brings them back
      message =
        records.length > 0
          ? `Cancelled. ${plural(records.length)} of ${
              candidates.length
            } already moved → ${path.basename(destinationDir)}`
          : 'Move cancelled, nothing was moved';
    }
    if (renamed > 0) {
      message += ` · ${renamed} renamed, the name was already taken`;
      if (duplicates > 0) {
        message += ` (${duplicates} exact duplicate${duplicates === 1 ? '' : 's'})`;
      }
    }
    this.report(
      records.length > 0 || isCancelled ? message : undefined,
      errors,
      records.length > 0 ? { label: 'Undo', onClick: () => this.undo() } : undefined,
      leftBehind,
    );
    if (records.length > 0 && nextFile) {
      runInAction(() => {
        // The file object is replaced when it was moved itself in the meantime
        const next = fileStore.get(nextFile.id);
        if (next) {
          uiStore.selectFile(next, true);
        }
      });
    }
    this.refreshViews();
  }

  /** Moves the selected files into a folder and continues with the next file (keyboard sorting) */
  async moveSelectionTo(destinationDir: string): Promise<void> {
    const files = runInAction(() => Array.from(this.rootStore.uiStore.fileSelection));
    if (files.length === 0) {
      AppToaster.show({ message: 'Select the files to move first', timeout: 3000 }, TOAST_KEY);
      return;
    }
    await this.moveFilesTo(files, destinationDir, { advance: true });
  }

  /** Moves the selected files into the folder that was used last */
  async moveSelectionToLastDestination(): Promise<void> {
    const destination = runInAction(
      () => this.lastDestination ?? this.history.filter((b) => !b.undone).at(-1)?.destination,
    );
    if (destination === undefined) {
      AppToaster.show({ message: 'No files were moved yet', timeout: 3000 }, TOAST_KEY);
      return;
    }
    await this.moveSelectionTo(destination);
  }

  private async persistTrash(): Promise<void> {
    if (!this.trashPath) {
      return;
    }
    if (this.pendingTrash.length > 0) {
      await fse.outputJSON(this.trashPath, this.pendingTrash).catch(console.error);
    } else {
      await fse.remove(this.trashPath).catch(console.error);
    }
  }

  /**
   * Deletes the selected files without asking, and continues with the next file.
   * Like moved files, they stay in the gallery (greyed out) until it is reloaded.
   *
   * The files are not sent to the recycle bin right away: they are set aside under another name
   * in their folder, so that Undo can bring them back, tags included. They go to the recycle bin
   * when other files are deleted, the gallery is reloaded, some minutes have passed,
   * or at the next start of Allusion.
   */
  async trashSelection(): Promise<void> {
    const { uiStore, fileStore } = this.rootStore;
    const files = runInAction(() => Array.from(uiStore.fileSelection).filter((f) => !f.isBroken));
    if (files.length === 0 || this.isBusy()) {
      return;
    }
    const nextFile = runInAction(() => {
      const last = Math.max(-1, ...files.map((f) => fileStore.getIndex(f.id) ?? -1));
      const next = last === -1 ? -1 : this.stepIndex(last, 1);
      return next > last ? (fileStore.fileList[next] as ClientFile | undefined) : undefined;
    });

    this.setIsMoving(true);
    const errors: string[] = [];
    let deleted = 0;
    try {
      // Only the files deleted last can be brought back
      await this.finalizeTrash();
      for (const file of files) {
        try {
          const original = file.absolutePath;
          const staged = `${original}.${generateId().slice(0, 8)}${TRASH_EXTENSION}`;
          // Keeps the folder watcher from reloading the gallery for this file
          this.recentMoves.set(comparablePath(original), Date.now());
          await fse.rename(original, staged);
          this.pendingTrash.push({ fileId: file.id, original, staged });
          await this.persistTrash();
          runInAction(() => {
            uiStore.deselectFile(file);
            // Nothing about this file is saved while it is set aside
            file.setBroken(true);
            this.movedMarks.set(file.id, 'Recycle bin');
          });
          deleted++;
        } catch (e: any) {
          console.error('Could not delete file', file.absolutePath, e);
          errors.push(e?.message ?? String(e));
        }
      }
      this.pendingTrashDate = Date.now();
      window.clearTimeout(this.trashTimer);
      this.trashTimer = window.setTimeout(() => this.finalizeTrash(), TRASH_UNDO_TIME);
    } finally {
      this.setIsMoving(false);
    }

    if (deleted > 0) {
      AppToaster.show(
        {
          message: `Deleted ${plural(deleted)} → recycle bin`,
          timeout: 10000,
          type: 'success',
          clickAction: { label: 'Undo', onClick: () => this.restoreTrash() },
        },
        TOAST_KEY,
      );
      if (nextFile) {
        runInAction(() => uiStore.selectFile(nextFile, true));
      }
    }
    if (errors.length > 0) {
      AppToaster.show(
        {
          message: `${plural(errors.length)} could not be deleted: ${errors[0]}`,
          timeout: 12000,
          type: 'error',
        },
        `${TOAST_KEY}-errors`,
      );
    }
    this.refreshViews();
  }

  /** Reloads the gallery, so the greyed out files that were moved or deleted disappear */
  async tidyUp(): Promise<void> {
    await this.finalizeTrash();
    await this.rootStore.fileStore.refetch();
  }

  /** Really deletes the files that were set aside: to the recycle bin, and out of the library */
  async finalizeTrash(): Promise<void> {
    window.clearTimeout(this.trashTimer);
    const items = this.pendingTrash;
    if (items.length === 0) {
      return;
    }
    this.pendingTrash = [];
    for (const item of items) {
      try {
        await this.backend.removeFiles([item.fileId]);
        if (await fse.pathExists(item.staged)) {
          // Back to its own name first, so it can be recognised in the recycle bin
          let target = item.staged;
          if (!(await fse.pathExists(item.original))) {
            this.recentMoves.set(comparablePath(item.original), Date.now());
            await fse.rename(item.staged, item.original);
            target = item.original;
          }
          const error = await RendererMessenger.trashFile(target);
          if (error) {
            throw error;
          }
        }
      } catch (e) {
        console.error('Could not send file to the recycle bin', item, e);
      }
    }
    await this.persistTrash();
    this.rootStore.fileStore.refetchFileCounts();
  }

  /** Brings back the files that were deleted last */
  async restoreTrash(): Promise<void> {
    window.clearTimeout(this.trashTimer);
    const items = this.pendingTrash;
    if (items.length === 0) {
      AppToaster.show(
        { message: 'These files are in the recycle bin already', timeout: 4000 },
        TOAST_KEY,
      );
      return;
    }
    this.pendingTrash = [];
    const { fileStore, uiStore } = this.rootStore;
    let restored = 0;
    let first: ClientFile | undefined;
    for (const item of items) {
      try {
        const target = await findFreePath(item.original);
        this.recentMoves.set(comparablePath(target), Date.now());
        await fse.rename(item.staged, target);
        if (target !== item.original) {
          await this.repairEntry({ fileId: item.fileId, from: item.original, to: target });
        }
        runInAction(() => {
          const loaded = fileStore.get(item.fileId);
          loaded?.setBroken(false);
          this.movedMarks.delete(item.fileId);
          first = first ?? loaded;
        });
        restored++;
      } catch (e) {
        console.error('Could not bring back file', item, e);
      }
    }
    await this.persistTrash();
    const file = first as ClientFile | undefined;
    if (file) {
      runInAction(() => uiStore.selectFile(file, true));
    }
    AppToaster.show(
      {
        message:
          restored === items.length
            ? `Brought back ${plural(restored)}`
            : `Brought back ${restored} of ${plural(items.length)}`,
        timeout: 5000,
        type: restored === items.length ? 'success' : 'warning',
      },
      TOAST_KEY,
    );
    this.refreshViews();
  }

  /** Asks for a folder and moves the selected files there */
  async moveSelectionWithDialog(): Promise<void> {
    const files = runInAction(() => Array.from(this.rootStore.uiStore.fileSelection));
    if (files.length === 0 || this.isBusy()) {
      return;
    }
    const result = await RendererMessenger.showOpenDialog({
      title: `Move ${plural(files.length)} to...`,
      buttonLabel: 'Move here',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: runInAction(() => this.lastDestination),
    });
    if (!result.canceled && result.filePaths.length > 0) {
      await this.moveFilesTo(files, result.filePaths[0]);
    }
  }

  /** Moves the files of a batch back (undo) or forth again (redo) */
  private async replay(batch: MoveBatch, direction: 'undo' | 'redo'): Promise<void> {
    this.setIsMoving(true);
    const failed: MoveRecord[] = [];
    const errors: string[] = [];
    let succeeded = 0;
    try {
      const records = direction === 'undo' ? batch.records.slice().reverse() : batch.records;
      for (const record of records) {
        const [from, to] =
          direction === 'undo' ? [record.to, record.from] : [record.from, record.to];
        try {
          // Never overwrite: if something else took the place in the meantime, leave the file where it is
          if (await fse.pathExists(to)) {
            throw new Error(`Another file now exists at "${to}"`);
          }
          await this.writePending({
            destination: batch.destination,
            done: [],
            current: { fileId: record.fileId, from, to },
            isReplay: true,
          });
          await this.relocate(record.fileId, from, to);
          succeeded++;
          runInAction(() =>
            direction === 'undo'
              ? this.movedMarks.delete(record.fileId)
              : this.movedMarks.set(record.fileId, path.basename(batch.destination)),
          );
        } catch (e: any) {
          console.error(`Could not ${direction} move`, record, e);
          failed.push(record);
          errors.push(e?.message ?? String(e));
        }
      }
      await this.journal?.setUndone(batch, direction === 'undo', failed);
      this.syncHistory();
    } finally {
      await this.clearPending();
      this.setIsMoving(false);
    }

    const folder = path.basename(batch.destination);
    this.report(
      succeeded > 0
        ? direction === 'undo'
          ? `Undid move of ${plural(succeeded)} → ${folder}`
          : `Moved ${plural(succeeded)} → ${folder} again`
        : undefined,
      errors,
      succeeded > 0
        ? direction === 'undo'
          ? { label: 'Redo', onClick: () => this.redo() }
          : { label: 'Undo', onClick: () => this.undo() }
        : undefined,
    );
    const { fileStore, uiStore } = this.rootStore;
    const loaded = runInAction(() =>
      batch.records.map((r) => fileStore.get(r.fileId)).filter((f) => f !== undefined),
    );
    if (direction === 'undo' && loaded.length > 0) {
      // Back to the file that was brought back, to sort it again
      runInAction(() => uiStore.selectFile(loaded[0], true));
    }
    if (loaded.length < batch.records.length && runInAction(() => !uiStore.isSlideMode)) {
      fileStore.debouncedRefetch();
    }
    this.refreshViews();
  }

  /** Undoes one move of the history, or does it again when it was undone */
  async toggleBatch(id: ID): Promise<void> {
    if (this.isBusy()) {
      return;
    }
    const batch = this.journal?.batches.find((b) => b.id === id);
    if (batch) {
      await this.replay(batch, batch.undone ? 'redo' : 'undo');
    }
  }

  async undo(): Promise<void> {
    if (this.isBusy()) {
      return;
    }
    const batch = this.journal?.nextUndo;
    // Deleting files was the last thing done: bring them back
    if (
      this.pendingTrash.length > 0 &&
      (batch === undefined || this.pendingTrashDate > batch.date)
    ) {
      await this.restoreTrash();
      return;
    }
    if (batch === undefined) {
      AppToaster.show({ message: 'No file move to undo', timeout: 3000 }, TOAST_KEY);
      return;
    }
    await this.replay(batch, 'undo');
  }

  async redo(): Promise<void> {
    if (this.isBusy()) {
      return;
    }
    const batch = this.journal?.nextRedo;
    if (batch === undefined) {
      AppToaster.show({ message: 'No file move to redo', timeout: 3000 }, TOAST_KEY);
      return;
    }
    await this.replay(batch, 'redo');
  }

  private report(
    success: string | undefined,
    errors: string[],
    clickAction?: { label: string; onClick: () => void },
    leftBehind = 0,
  ) {
    if (success !== undefined) {
      AppToaster.show({ message: success, clickAction, timeout: 8000, type: 'success' }, TOAST_KEY);
    } else if (errors.length === 0) {
      AppToaster.dismiss(TOAST_KEY);
    }
    if (errors.length > 0) {
      AppToaster.show(
        {
          message: `${plural(errors.length)} could not be moved: ${errors[0]}`,
          timeout: 12000,
          type: 'error',
        },
        `${TOAST_KEY}-errors`,
      );
    }
    if (leftBehind > 0) {
      AppToaster.show(
        {
          message: `${plural(
            leftBehind,
          )} were copied and verified, but the original could not be deleted (in use by another program?).`,
          timeout: 12000,
          type: 'warning',
        },
        `${TOAST_KEY}-left-behind`,
      );
    }
  }

  private refreshViews() {
    // The gallery is not reloaded on purpose: moved files stay in place (greyed out),
    // so the arrangement does not jump around while sorting.
    this.rootStore.fileStore.refetchFileCounts();
    // The library is saved a moment after a move: count again once that is done
    window.setTimeout(() => this.rootStore.sortStore.refreshUnsortedCount(), 1500);
  }
}

export default MoveStore;
