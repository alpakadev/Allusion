import { spawn } from 'child_process';
import fse from 'fs-extra';
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import path from 'path';

import { getThumbnailPath, isFileExtensionVideo } from 'common/fs';
import { DataStorage } from 'src/api/data-storage';
import { ConditionDTO } from 'src/api/data-storage-search';
import { FileDTO } from 'src/api/file';
import { OrderDirection } from 'src/api/data-storage-search';
import { RendererMessenger } from 'src/ipc/renderer';
import { AppToaster } from '../components/Toaster';
import { ClientStringSearchCriteria } from '../entities/SearchCriteria';
import RootStore from './RootStore';

const STORAGE_KEY = 'sort-preferences';
const TOAST_KEY = 'sort-panel';
const MAX_DEPTH = 10;
const MAX_RECENTS = 6;

export interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
}

/** A folder files can be moved into, for the keyboard picker */
export interface FolderEntry {
  path: string;
  name: string;
  /** Where the folder lies, e.g. "Root / Parent" */
  location: string;
}

export const PIN_SLOTS = 9;

/** A program the user added to open files with, e.g. an image editor */
export interface ExternalApp {
  name: string;
  path: string;
}
const MAX_THUMBS = 80;
const MAX_COUNTED_FOLDERS = 400;
/** Up to this size, an image without a thumbnail is shown itself on a folder tile */
const MAX_THUMB_SOURCE_SIZE = 3 * 1024 * 1024;

export const FOLDER_COLORS: [name: string, color: string][] = [
  ['Red', '#e5484d'],
  ['Orange', '#f76b15'],
  ['Yellow', '#ffc53d'],
  ['Green', '#46a758'],
  ['Teal', '#12a594'],
  ['Blue', '#3e63dd'],
  ['Purple', '#8e4ec6'],
  ['Pink', '#e93d82'],
];

type Preferences = {
  roots: string[];
  activeRoot: string | null;
  isPanelOpen: boolean;
  panelWidth: number;
  expanded: string[];
  isLocked?: boolean;
  viewMode?: ViewMode;
  pins?: (string | null)[];
  isQuickMoveSticky?: boolean;
  colors?: Record<string, string>;
  externalApps?: ExternalApp[];
  pictures?: Record<string, string>;
};

/** How sub folders are shown: as an indented tree, or as large tiles side by side */
export type ViewMode = 'tree' | 'tiles';

const INVALID_NAME = /[\\/:*?"<>|]/;

async function scanFolder(dir: string, depth = 0): Promise<FolderNode> {
  const node: FolderNode = { path: dir, name: path.basename(dir) || dir, children: [] };
  if (depth >= MAX_DEPTH) {
    return node;
  }
  try {
    const entries = await fse.readdir(dir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    node.children = await Promise.all(
      dirs.map((d) => scanFolder(path.join(dir, d.name), depth + 1)),
    );
    node.children.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
  } catch (e) {
    console.warn('Could not read folder', dir, e);
  }
  return node;
}

/**
 * State of the "sort by moving" workflow: the destination folder trees the user sorts files into.
 * Nothing about the folder structure is stored: the trees are always read from disk,
 * only the root folders are remembered.
 */
class SortStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

  @observable isPanelOpen = false;
  @observable panelWidth = 280;
  /** When locked, dragging files over a folder does not expand it */
  @observable isLocked = false;
  @observable viewMode: ViewMode = 'tree';
  /** Per root: the amount of files that lie directly in it, not in one of its sub folders */
  readonly looseCounts = observable.map<string, number>();
  /** Absolute paths of the destination root folders */
  readonly roots = observable<string>([]);
  /** The root that is shown in the panel; null shows all of them */
  @observable activeRoot: string | null = null;
  /** Folder tree per root, as currently found on disk */
  readonly trees = observable.map<string, FolderNode>({}, { deep: false });
  readonly expanded = observable.set<string>();
  @observable filter = '';
  /** Amount of files in the library that are not inside any destination root */
  @observable unsortedCount: number | undefined = undefined;
  /** Folders assigned to the number keys 1-9 of the keyboard picker */
  readonly pins = observable<string | null>(new Array(PIN_SLOTS).fill(null));
  /** Colours the user gave to folders: folder path -> CSS colour */
  readonly colors = observable.map<string, string>();
  /** A picture of each folder that is shown as a tile: folder path -> image path */
  readonly thumbs = observable.map<string, string>();
  /** The programs of the "Open With" menu */
  readonly externalApps = observable<ExternalApp>([]);
  /** Pictures the user chose for folders: folder path -> path of the image */
  readonly pictures = observable.map<string, string>();
  /** How many files of the library are in each folder, sub folders included */
  readonly folderCounts = observable.map<string, number>();
  /** The folder whose sub folders are shown in the tile view, when the user opened one */
  @observable tileFolder: string | null = null;
  private countRun = 0;
  @observable isQuickMoveOpen = false;
  /** Whether the keyboard picker stays open after a move, to sort one file after the other */
  @observable isQuickMoveSticky = true;
  /** Changes when the keyboard picker should grab the focus */
  @observable quickMoveFocus = 0;

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;
    makeObservable(this);
  }

  init(): void {
    this.recoverPreferences();
    // Keep the counter up to date when files are moved, undone or redone
    reaction(
      () => this.rootStore.moveStore.history.map((b) => `${b.id}${b.undone}`).join(),
      () => this.refreshUnsortedCount(),
    );
    if (runInAction(() => this.isPanelOpen)) {
      this.refresh();
    }
  }

  /////////////////// Preferences ///////////////////

  @action private recoverPreferences() {
    try {
      const prefs = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Preferences | null;
      if (prefs) {
        this.roots.replace(prefs.roots ?? []);
        this.activeRoot =
          prefs.activeRoot && this.roots.includes(prefs.activeRoot) ? prefs.activeRoot : null;
        this.isPanelOpen = Boolean(prefs.isPanelOpen);
        this.panelWidth = prefs.panelWidth || this.panelWidth;
        this.isLocked = Boolean(prefs.isLocked);
        this.viewMode = prefs.viewMode === 'tiles' ? 'tiles' : 'tree';
        this.expanded.replace(prefs.expanded ?? []);
        if (Array.isArray(prefs.pins)) {
          this.pins.replace(this.pins.map((_, i) => prefs.pins?.[i] ?? null));
        }
        this.isQuickMoveSticky = prefs.isQuickMoveSticky !== false;
        this.colors.replace(prefs.colors ?? {});
        this.externalApps.replace(prefs.externalApps ?? []);
        this.pictures.replace(prefs.pictures ?? {});
      }
    } catch (e) {
      console.error('Could not restore sort preferences', e);
    }
  }

  private persist() {
    const prefs: Preferences = runInAction(() => ({
      roots: this.roots.slice(),
      activeRoot: this.activeRoot,
      isPanelOpen: this.isPanelOpen,
      panelWidth: this.panelWidth,
      isLocked: this.isLocked,
      viewMode: this.viewMode,
      expanded: Array.from(this.expanded),
      pins: this.pins.slice(),
      isQuickMoveSticky: this.isQuickMoveSticky,
      colors: Object.fromEntries(this.colors),
      externalApps: this.externalApps.map((app) => ({ ...app })),
      pictures: Object.fromEntries(this.pictures),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }

  /////////////////// Panel state ///////////////////

  @action.bound togglePanel(): void {
    this.isPanelOpen = !this.isPanelOpen;
    this.persist();
    if (this.isPanelOpen) {
      this.refresh();
    }
  }

  @action.bound toggleLock(): void {
    this.isLocked = !this.isLocked;
    this.persist();
  }

  @action.bound toggleViewMode(): void {
    this.viewMode = this.viewMode === 'tree' ? 'tiles' : 'tree';
    this.persist();
    this.refreshThumbs();
  }

  @action.bound setPanelWidth(width: number): void {
    this.panelWidth = Math.max(180, Math.min(width, 800));
    this.persist();
  }

  @action.bound setActiveRoot(root: string | null): void {
    this.activeRoot = root;
    this.persist();
  }

  @action.bound setFilter(filter: string): void {
    this.filter = filter;
  }

  @action.bound toggleExpansion(folder: string, expand?: boolean): void {
    const shouldExpand = expand ?? !this.expanded.has(folder);
    if (shouldExpand) {
      this.expanded.add(folder);
    } else {
      this.expanded.delete(folder);
    }
    this.persist();
  }

  /////////////////// Keyboard sorting ///////////////////

  /** Opens the keyboard picker, or gives it the focus again */
  @action.bound openQuickMove(): void {
    if (this.roots.length === 0) {
      this.isPanelOpen = true;
      this.persist();
      return;
    }
    if (this.trees.size === 0) {
      this.refresh();
    }
    this.isQuickMoveOpen = true;
    this.quickMoveFocus++;
  }

  @action.bound closeQuickMove(): void {
    this.isQuickMoveOpen = false;
  }

  @action.bound toggleQuickMoveSticky(): void {
    this.isQuickMoveSticky = !this.isQuickMoveSticky;
    this.persist();
  }

  /** The number key (1-9) a folder is assigned to */
  pinOf(folder: string): number | undefined {
    const index = this.resolvedPins.indexOf(folder);
    return index === -1 ? undefined : index + 1;
  }

  /**
   * The folders of the number keys. While one destination is active, a key that belongs to a
   * folder of another destination stands for the folder with the same place there, if it exists.
   * So one set of keys works for destinations that are organised alike.
   */
  @computed get resolvedPins(): (string | null)[] {
    return this.pins.map((pinned) => (pinned === null ? null : this.toActiveRoot(pinned)));
  }

  @computed private get knownFolders(): Set<string> {
    const known = new Set<string>();
    const visit = (node: FolderNode) => {
      known.add(node.path);
      node.children.forEach(visit);
    };
    this.trees.forEach(visit);
    return known;
  }

  /**
   * While one destination is active: the folder with the same place in that destination,
   * if the given folder belongs to another one and such a folder exists.
   */
  toActiveRoot(folder: string): string {
    const active = this.activeRoot;
    if (active === null || folder === active || folder.startsWith(active + path.sep)) {
      return folder;
    }
    const root = this.roots.find((r) => folder.startsWith(r + path.sep));
    const twin = root !== undefined ? active + folder.slice(root.length) : undefined;
    return twin !== undefined && this.knownFolders.has(twin) ? twin : folder;
  }

  /** The folder to offer first in the keyboard picker: where the last file went */
  @computed get suggestedFolder(): string | undefined {
    const last = this.rootStore.moveStore.lastDestination ?? this.recentDestinations.at(0);
    return last !== undefined ? this.toActiveRoot(last) : undefined;
  }

  /** Like findNode, but usable while rendering: changes to the folders are noticed */
  getNode(folder: string): FolderNode | undefined {
    const visit = (node: FolderNode): FolderNode | undefined =>
      node.path === folder ? node : node.children.map(visit).find((n) => n !== undefined);
    return Array.from(this.trees.values())
      .map(visit)
      .find((n) => n !== undefined);
  }

  /** Opens a folder in the tile view, to show its sub folders as tiles. Null goes back to the top. */
  @action.bound setTileFolder(folder: string | null): void {
    this.tileFolder = folder !== null && !this.roots.includes(folder) ? folder : null;
    this.refreshThumbs().catch(console.error);
  }

  /** Uses an image as the picture of the folder it is in (and of the folders above without one) */
  @action.bound setFolderPicture(imagePath: string): void {
    const root = this.roots.find((r) => imagePath.startsWith(r + path.sep));
    if (root === undefined) {
      AppToaster.show(
        { message: 'This file is not in one of your destination folders', timeout: 4000 },
        TOAST_KEY,
      );
      return;
    }
    let folder = path.dirname(imagePath);
    const own = folder;
    while (folder !== root && folder.startsWith(root + path.sep)) {
      if (folder === own || !this.pictures.has(folder)) {
        this.pictures.set(folder, imagePath);
      }
      folder = path.dirname(folder);
    }
    this.persist();
    this.refreshThumbs().catch(console.error);
    AppToaster.show(
      { message: `Now the picture of "${path.basename(own)}"`, timeout: 4000, type: 'success' },
      TOAST_KEY,
    );
  }

  /** Counts the files in each folder */
  private async refreshFolderCounts(): Promise<void> {
    if (runInAction(() => !this.isPanelOpen)) {
      return;
    }
    const run = ++this.countRun;
    const folders = runInAction(() => Array.from(this.knownFolders).slice(0, MAX_COUNTED_FOLDERS));
    const counts = new Map<string, number>();
    for (const folder of folders) {
      // A newer run has started in the meantime
      if (run !== this.countRun) {
        return;
      }
      const [count] = await this.backend.countFiles(
        { files: true, untagged: false },
        {
          conjunction: 'and',
          children: [
            runInAction(
              () =>
                new ClientStringSearchCriteria(
                  undefined,
                  'absolutePath',
                  folder + path.sep,
                  'startsWith',
                ).toCondition() as ConditionDTO<FileDTO>,
            ),
          ],
        },
      );
      counts.set(folder, count ?? 0);
    }
    runInAction(() => this.folderCounts.replace(counts));
  }

  @action.bound unpinKey(key: number): void {
    this.pins[key - 1] = null;
    this.persist();
  }

  /** Shows the next destination only (or the previous one) */
  @action.bound cycleActiveRoot(delta: number): void {
    if (this.roots.length === 0) {
      return;
    }
    const current = this.activeRoot === null ? -1 : this.roots.indexOf(this.activeRoot);
    const next =
      current === -1
        ? delta > 0
          ? 0
          : this.roots.length - 1
        : (current + delta + this.roots.length) % this.roots.length;
    this.activeRoot = this.roots[next];
    this.persist();
  }

  /** The colour of a folder: its own, or else the one of the closest parent folder that has one */
  colorOf(folder: string): string | undefined {
    let current = folder;
    for (let i = 0; i < MAX_DEPTH + 2; i++) {
      const color = this.colors.get(current);
      if (color !== undefined) {
        return color;
      }
      const parent = path.dirname(current);
      if (parent === current || this.roots.includes(current)) {
        return undefined;
      }
      current = parent;
    }
    return undefined;
  }

  @action.bound setColor(folder: string, color: string | undefined): void {
    if (color === undefined) {
      this.colors.delete(folder);
    } else {
      this.colors.set(folder, color);
    }
    this.persist();
  }

  /** Finds a picture for each folder that is shown as a tile */
  private async refreshThumbs(): Promise<void> {
    if (runInAction(() => this.viewMode !== 'tiles' || !this.isPanelOpen)) {
      return;
    }
    const folders = runInAction(() =>
      Array.from(this.trees.values())
        .flatMap((tree) => tree.children.map((child) => child.path))
        .concat(
          this.tileFolder !== null
            ? this.getNode(this.tileFolder)?.children.map((child) => child.path) ?? []
            : [],
        )
        .slice(0, MAX_THUMBS),
    );
    const thumbnailDirectory = runInAction(() => this.rootStore.uiStore.thumbnailDirectory);
    const found = await Promise.all(
      folders.map(async (folder) => {
        try {
          const custom = runInAction(() => this.pictures.get(folder));
          if (custom !== undefined && (await fse.pathExists(custom))) {
            const customThumb = getThumbnailPath(custom, thumbnailDirectory);
            return [folder, (await fse.pathExists(customThumb)) ? customThumb : custom] as const;
          }
          const [file] = await this.backend.searchFiles(
            {
              conjunction: 'and',
              children: [
                runInAction(
                  () =>
                    new ClientStringSearchCriteria(
                      undefined,
                      'absolutePath',
                      folder + path.sep,
                      'startsWith',
                    ).toCondition() as ConditionDTO<FileDTO>,
                ),
              ],
            },
            'dateAdded',
            OrderDirection.Desc,
            false,
            1,
          );
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (file === undefined) {
            return undefined;
          }
          const thumbnail = getThumbnailPath(file.absolutePath, thumbnailDirectory);
          if (await fse.pathExists(thumbnail)) {
            return [folder, thumbnail] as const;
          }
          // Small images have no thumbnail of their own
          if (!isFileExtensionVideo(file.extension) && file.size <= MAX_THUMB_SOURCE_SIZE) {
            return [folder, file.absolutePath] as const;
          }
        } catch (e) {
          console.error('Could not find a picture for folder', folder, e);
        }
        return undefined;
      }),
    );
    runInAction(() =>
      this.thumbs.replace(
        new Map(found.filter((f): f is readonly [string, string] => f !== undefined)),
      ),
    );
  }

  /** Assigns a folder to a number key: the given one, or else the first free one */
  @action.bound pin(folder: string, key?: number): void {
    const index = key !== undefined ? key - 1 : this.pins.indexOf(null);
    if (index < 0 || index >= PIN_SLOTS) {
      return;
    }
    const current = this.pins.indexOf(folder);
    if (current !== -1) {
      this.pins[current] = null;
    }
    this.pins[index] = folder;
    this.persist();
  }

  @action.bound unpin(folder: string): void {
    const index = this.pins.indexOf(folder);
    if (index !== -1) {
      this.pins[index] = null;
      this.persist();
    }
  }

  /** All folders of all destinations, as a flat list */
  @computed get folderEntries(): FolderEntry[] {
    const entries: FolderEntry[] = [];
    const visit = (node: FolderNode, location: string) => {
      for (const child of node.children) {
        entries.push({ path: child.path, name: child.name, location });
        visit(child, `${location} / ${child.name}`);
      }
    };
    // Only the destination that is active, when one is chosen
    for (const tree of this.visibleTrees) {
      const label = this.rootLabel(tree.path);
      entries.push({ path: tree.path, name: label, location: '' });
      visit(tree, label);
    }
    return entries;
  }

  /** Selects the file before or after the selected one, without moving anything */
  @action.bound stepSelection(delta: number): void {
    const { uiStore, fileStore } = this.rootStore;
    const selected = uiStore.fileSelection.values().next().value as { id: string } | undefined;
    const current = selected ? fileStore.getIndex(selected.id) : undefined;
    // Files that were moved already are skipped
    const index =
      current === undefined
        ? uiStore.firstItemIndex
        : this.rootStore.moveStore.stepIndex(current, delta > 0 ? 1 : -1);
    const file = fileStore.fileList[Math.max(0, Math.min(index, fileStore.fileList.length - 1))];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (file) {
      uiStore.selectFile(file, true);
    }
  }

  /** The roots that are currently shown in the panel */
  @computed get visibleTrees(): FolderNode[] {
    const roots = this.activeRoot !== null ? [this.activeRoot] : this.roots;
    return roots.map((r) => this.trees.get(r)).filter((t): t is FolderNode => t !== undefined);
  }

  /** The folders files were most recently moved into, newest first */
  @computed get recentDestinations(): string[] {
    const recents: string[] = [];
    const history = this.rootStore.moveStore.history;
    for (let i = history.length - 1; i >= 0 && recents.length < MAX_RECENTS; i--) {
      const batch = history[i];
      if (!batch.undone && !recents.includes(batch.destination)) {
        recents.push(batch.destination);
      }
    }
    return recents;
  }

  /** A name for a root that tells roots with the same folder name apart */
  rootLabel(root: string): string {
    const name = path.basename(root) || root;
    const hasTwin = runInAction(() =>
      this.roots.some((r) => r !== root && (path.basename(r) || r) === name),
    );
    return hasTwin ? `${path.basename(path.dirname(root))}/${name}` : name;
  }

  /////////////////// Reading from disk ///////////////////

  /** Re-reads the folder trees from disk and updates the counter */
  @action.bound async refresh(): Promise<void> {
    const roots = runInAction(() => this.roots.slice());
    const trees = await Promise.all(
      roots.map(async (root) =>
        (await fse.pathExists(root)) ? ([root, await scanFolder(root)] as const) : undefined,
      ),
    );
    runInAction(() => {
      this.trees.replace(new Map(trees.filter((t): t is [string, FolderNode] => t !== undefined)));
    });
    this.refreshThumbs().catch(console.error);
    await this.refreshUnsortedCount();
  }

  /** Criteria matching the files that lie directly in a folder, not in one of its sub folders */
  private looseFileCriteria(node: FolderNode): ClientStringSearchCriteria[] {
    return [
      new ClientStringSearchCriteria(undefined, 'absolutePath', node.path + path.sep, 'startsWith'),
      ...node.children.map(
        (child) =>
          new ClientStringSearchCriteria(
            undefined,
            'absolutePath',
            child.path + path.sep,
            'notStartsWith',
          ),
      ),
    ];
  }

  private findNode(folder: string): FolderNode | undefined {
    const visit = (node: FolderNode): FolderNode | undefined =>
      node.path === folder ? node : node.children.map(visit).find((n) => n !== undefined);
    return runInAction(() =>
      Array.from(this.trees.values())
        .map(visit)
        .find((n) => n !== undefined),
    );
  }

  /**
   * Shows only the files that lie directly in a folder: handy when unsorted files
   * are collected in a destination root, next to its category folders.
   */
  @action.bound showLooseFiles(folder: string): void {
    const node = this.findNode(folder);
    if (node) {
      this.rootStore.uiStore.replaceSearchCriterias(this.looseFileCriteria(node));
    }
  }

  private async refreshLooseCounts(): Promise<void> {
    const roots = runInAction(() => Array.from(this.trees.values()));
    const counts = await Promise.all(
      roots.map(async (root) => {
        const [count] = await this.backend.countFiles(
          { files: true, untagged: false },
          {
            conjunction: 'and',
            children: runInAction(() =>
              this.looseFileCriteria(root).map((c) => c.toCondition() as ConditionDTO<FileDTO>),
            ),
          },
        );
        return [root.path, count ?? 0] as const;
      }),
    );
    runInAction(() => this.looseCounts.replace(new Map(counts)));
  }

  /**
   * Criteria for the files that still have to be sorted: everything that is not inside one of the
   * category folders. That includes files lying directly in a destination root.
   * A root without sub folders is a category itself.
   */
  private unsortedCriteria(): ClientStringSearchCriteria[] {
    return this.roots.flatMap((root) => {
      const children = this.trees.get(root)?.children ?? [];
      const folders = children.length > 0 ? children.map((c) => c.path) : [root];
      return folders.map(
        (folder) =>
          new ClientStringSearchCriteria(
            undefined,
            'absolutePath',
            folder + path.sep,
            'notStartsWith',
          ),
      );
    });
  }

  private unsortedConditions(): ConditionDTO<FileDTO>[] {
    return runInAction(() =>
      this.unsortedCriteria().map((c) => c.toCondition() as ConditionDTO<FileDTO>),
    );
  }

  async refreshUnsortedCount(): Promise<void> {
    this.refreshLooseCounts().catch((e) => console.error('Could not count loose files', e));
    this.refreshFolderCounts().catch((e) => console.error('Could not count files', e));
    const conditions = this.unsortedConditions();
    if (conditions.length === 0) {
      runInAction(() => (this.unsortedCount = undefined));
      return;
    }
    try {
      const [count] = await this.backend.countFiles(
        { files: true, untagged: false },
        { conjunction: 'and', children: conditions },
      );
      runInAction(() => (this.unsortedCount = count));
    } catch (e) {
      console.error('Could not count unsorted files', e);
    }
  }

  /** Shows only the files that are not inside any of the destination roots */
  @action.bound showUnsorted(): void {
    if (this.roots.length === 0) {
      return;
    }
    this.rootStore.uiStore.replaceSearchCriterias(this.unsortedCriteria());
  }

  /////////////////// Destination roots ///////////////////

  async addRootWithDialog(): Promise<void> {
    const result = await RendererMessenger.showOpenDialog({
      title: 'Choose a folder to sort files into',
      buttonLabel: 'Use as destination',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return;
    }
    const root = path.normalize(result.filePaths[0]);
    if (runInAction(() => this.roots.includes(root))) {
      return;
    }

    // Moved files must stay in the library, so the folder has to be (part of) a Location
    if (this.rootStore.moveStore.findLocation(root) === undefined) {
      const res = await RendererMessenger.showMessageBox({
        type: 'question',
        title: 'Add as Location?',
        message: `"${path.basename(root)}" is not part of your library yet.`,
        detail:
          'To keep sorted files visible in Allusion, this folder will be added as a Location. Its images and videos will be imported.',
        buttons: ['&Add as Location', '&Cancel'],
        normalizeAccessKeys: true,
        defaultId: 0,
        cancelId: 1,
      });
      if (res.response !== 0) {
        return;
      }
      const { locationStore } = this.rootStore;
      const location = await locationStore.create(root);
      await locationStore.initLocation(location);
    }

    runInAction(() => {
      this.roots.push(root);
      this.expanded.add(root);
    });
    this.persist();
    await this.refresh();
  }

  /** Stops showing a root in the panel. Does not touch the folder or the Location. */
  @action.bound removeRoot(root: string): void {
    this.roots.remove(root);
    this.trees.delete(root);
    if (this.activeRoot === root) {
      this.activeRoot = null;
    }
    this.persist();
    this.refreshUnsortedCount();
  }

  /** Removes all destinations from the panel, after asking. The folders and files are not touched. */
  async removeAllRoots(): Promise<void> {
    const res = await RendererMessenger.showMessageBox({
      type: 'question',
      title: 'Remove all destinations',
      message: 'Remove all destination folders from this panel?',
      detail:
        'Only the list in this panel is cleared. The folders and their files stay where they are, and they remain in your library.',
      buttons: ['Remove all', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (res.response !== 0) {
      return;
    }
    runInAction(() => {
      this.roots.clear();
      this.trees.clear();
      this.activeRoot = null;
      this.tileFolder = null;
      this.unsortedCount = undefined;
    });
    this.persist();
  }

  /////////////////// Open with a program ///////////////////

  /** Asks for a program and adds it to the "Open With" menu */
  async addExternalAppWithDialog(): Promise<ExternalApp | undefined> {
    const result = await RendererMessenger.showOpenDialog({
      title: 'Choose a program to open files with',
      buttonLabel: 'Use this program',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'com'] }]
          : undefined,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return undefined;
    }
    const appPath = result.filePaths[0];
    const app: ExternalApp = { name: path.basename(appPath, path.extname(appPath)), path: appPath };
    runInAction(() => {
      if (!this.externalApps.some((a) => a.path === appPath)) {
        this.externalApps.push(app);
      }
    });
    this.persist();
    return app;
  }

  @action.bound removeExternalApp(appPath: string): void {
    const app = this.externalApps.find((a) => a.path === appPath);
    if (app) {
      this.externalApps.remove(app);
      this.persist();
    }
  }

  /** Opens files with one of the programs */
  openWith(app: ExternalApp, files: string[]): void {
    if (files.length === 0) {
      return;
    }
    const fail = (e: unknown) => {
      console.error('Could not open files with', app.path, e);
      AppToaster.show(
        { message: `Could not start "${app.name}"`, timeout: 6000, type: 'error' },
        TOAST_KEY,
      );
    };
    try {
      // On macOS programs are bundles, which are started through "open"
      const isBundle = process.platform === 'darwin' && app.path.endsWith('.app');
      const child = isBundle
        ? spawn('open', ['-a', app.path, ...files], { detached: true, stdio: 'ignore' })
        : spawn(app.path, files, { detached: true, stdio: 'ignore' });
      child.on('error', fail);
      child.unref();
    } catch (e) {
      fail(e);
    }
  }

  /////////////////// Folder operations ///////////////////

  private validateName(name: string): string | undefined {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === '.' || trimmed === '..' || INVALID_NAME.test(trimmed)) {
      AppToaster.show(
        { message: `"${name}" is not a valid folder name`, timeout: 5000, type: 'warning' },
        TOAST_KEY,
      );
      return undefined;
    }
    return trimmed;
  }

  /** Creates a new folder inside the given one. Returns its path if successful. */
  async createFolder(parent: string, name: string): Promise<string | undefined> {
    const validName = this.validateName(name);
    if (validName === undefined) {
      return undefined;
    }
    const target = path.join(parent, validName);
    if (await fse.pathExists(target)) {
      AppToaster.show(
        { message: `"${validName}" already exists`, timeout: 5000, type: 'warning' },
        TOAST_KEY,
      );
      return undefined;
    }
    try {
      await fse.mkdir(target);
    } catch (e: any) {
      AppToaster.show(
        { message: `Could not create folder: ${e?.message}`, timeout: 8000, type: 'error' },
        TOAST_KEY,
      );
      return undefined;
    }
    this.toggleExpansion(parent, true);
    await this.refresh();
    return target;
  }

  /** Stores changed file paths in the database, and in the files that are currently loaded */
  private async applyPaths(files: FileDTO[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    await this.backend.saveFiles(files);
    const { fileStore, uiStore } = this.rootStore;
    runInAction(() => {
      for (const file of files) {
        const loaded = fileStore.get(file.id);
        if (loaded && loaded.absolutePath !== file.absolutePath) {
          uiStore.deselectFile(loaded);
          fileStore.replaceMovedFile(loaded, file);
        }
      }
    });
  }

  /**
   * Renames a folder on disk, and updates the paths of all files in it in the database,
   * so they do not show up as missing.
   */
  async renameFolder(folder: string, newName: string): Promise<string | undefined> {
    const validName = this.validateName(newName);
    if (validName === undefined || validName === path.basename(folder)) {
      return undefined;
    }
    if (runInAction(() => this.roots.includes(folder))) {
      AppToaster.show(
        { message: 'Destination roots cannot be renamed from here', timeout: 5000 },
        TOAST_KEY,
      );
      return undefined;
    }
    const target = path.join(path.dirname(folder), validName);
    // Allow changing only the capitalization on case-insensitive file systems
    const isCaseChange = target.toLowerCase() === folder.toLowerCase();
    if (!isCaseChange && (await fse.pathExists(target))) {
      AppToaster.show(
        { message: `"${validName}" already exists`, timeout: 5000, type: 'warning' },
        TOAST_KEY,
      );
      return undefined;
    }

    const oldPrefix = folder + path.sep;
    const newPrefix = target + path.sep;
    try {
      const files = await this.backend.searchFiles(
        {
          conjunction: 'and',
          children: [
            new ClientStringSearchCriteria(
              undefined,
              'absolutePath',
              oldPrefix,
              'startsWith',
            ).toCondition(),
          ],
        },
        'id',
        OrderDirection.Asc,
        false,
      );

      // Update the library before touching the disk: when the folder watcher notices the rename,
      // the files are then already known under their new paths, instead of being marked as missing.
      const location = this.rootStore.moveStore.findLocation(target);
      const renamed = files.map((file) => {
        const absolutePath = newPrefix + file.absolutePath.slice(oldPrefix.length);
        return {
          ...file,
          absolutePath,
          relativePath: location ? absolutePath.slice(location.path.length) : file.relativePath,
        };
      });
      await this.applyPaths(renamed);
      try {
        await fse.rename(folder, target);
      } catch (e) {
        await this.applyPaths(files).catch(console.error);
        throw e;
      }
    } catch (e: any) {
      console.error('Could not rename folder', e);
      AppToaster.show(
        { message: `Could not rename folder: ${e?.message}`, timeout: 8000, type: 'error' },
        TOAST_KEY,
      );
      return undefined;
    }

    runInAction(() => {
      // Keep sub folders expanded under their new path
      for (const expandedPath of Array.from(this.expanded)) {
        if (expandedPath === folder || expandedPath.startsWith(oldPrefix)) {
          this.expanded.delete(expandedPath);
          this.expanded.add(target + expandedPath.slice(folder.length));
        }
      }
    });
    runInAction(() => {
      for (const [colored, color] of Array.from(this.colors)) {
        if (colored === folder || colored.startsWith(folder + path.sep)) {
          this.colors.delete(colored);
          this.colors.set(target + colored.slice(folder.length), color);
        }
      }
      this.pins.forEach((pinned, i) => {
        if (pinned !== null && (pinned === folder || pinned.startsWith(folder + path.sep))) {
          this.pins[i] = target + pinned.slice(folder.length);
        }
      });
    });
    this.persist();
    await this.refresh();
    this.rootStore.fileStore.debouncedRefetch();
    return target;
  }
}

export default SortStore;
