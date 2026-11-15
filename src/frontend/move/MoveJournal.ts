/**
 * A persistent log of file moves, which doubles as the undo/redo stack.
 * Plain data + file IO only: no imports from the rest of the app.
 */
import * as fse from 'fs-extra';

export interface MoveRecord {
  /** ID of the file in Allusion's database */
  fileId: string;
  from: string;
  to: string;
}

export interface MoveBatch {
  id: string;
  /** Timestamp (ms) */
  date: number;
  /** The folder the files were moved into */
  destination: string;
  records: MoveRecord[];
  /** Whether this batch is currently undone (and can be redone) */
  undone: boolean;
}

export class MoveJournal {
  batches: MoveBatch[] = [];

  constructor(private readonly filePath: string, private readonly maxBatches = 500) {}

  async load(): Promise<void> {
    try {
      if (await fse.pathExists(this.filePath)) {
        const data = await fse.readJSON(this.filePath);
        if (Array.isArray(data?.batches)) {
          this.batches = data.batches;
        }
      }
    } catch (e) {
      console.error('Could not read move history, starting with an empty one', e);
      this.batches = [];
    }
  }

  private async persist(): Promise<void> {
    // Write to a temporary file first, so a crash while writing cannot corrupt the history
    const tmp = `${this.filePath}.tmp`;
    await fse.outputJSON(tmp, { version: 1, batches: this.batches });
    await fse.move(tmp, this.filePath, { overwrite: true });
  }

  /** Adds a new batch. Like any undo stack, batches that were undone can no longer be redone afterwards. */
  async push(batch: MoveBatch): Promise<void> {
    this.batches = this.batches.filter((b) => !b.undone);
    this.batches.push(batch);
    if (this.batches.length > this.maxBatches) {
      this.batches.splice(0, this.batches.length - this.maxBatches);
    }
    await this.persist();
  }

  /** The most recent batch that has not been undone */
  get nextUndo(): MoveBatch | undefined {
    for (let i = this.batches.length - 1; i >= 0; i--) {
      if (!this.batches[i].undone) {
        return this.batches[i];
      }
    }
    return undefined;
  }

  /** The oldest batch that has been undone */
  get nextRedo(): MoveBatch | undefined {
    return this.batches.find((b) => b.undone);
  }

  /**
   * Updates a batch after an undo or redo.
   * @param remaining The records that could NOT be undone/redone. They are dropped from the batch,
   * since their files are no longer where the journal expects them.
   */
  async setUndone(batch: MoveBatch, undone: boolean, remaining: MoveRecord[] = []): Promise<void> {
    const index = this.batches.indexOf(batch);
    if (index === -1) {
      return;
    }
    if (remaining.length === batch.records.length) {
      return; // nothing changed
    }
    if (remaining.length > 0) {
      batch.records = batch.records.filter((r) => !remaining.includes(r));
    }
    batch.undone = undone;
    await this.persist();
  }
}
