import { shell } from 'electron';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import path from 'path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { encodeFilePath } from 'common/fs';
import { IconSet } from 'widgets';
import { IconButton } from 'widgets/button';
import { Menu, MenuDivider, MenuItem, MenuSubItem, useContextMenu } from 'widgets/menus';
import { ToolbarButton } from 'widgets/toolbar';
import { AppToaster } from '../../components/Toaster';
import { useStore } from '../../contexts/StoreContext';
import { ClientFile } from '../../entities/File';
import { fuzzyScore } from '../../move/fuzzy';
import RootStore from '../../stores/RootStore';
import { FOLDER_COLORS, FolderNode, PIN_SLOTS } from '../../stores/SortStore';

const HOVER_TIME_TO_EXPAND = 600;

/** A file path as an address for CSS, where backslashes would be read as escape characters */
function toCssUrl(filePath: string): string {
  const encoded = encodeFilePath(filePath).replace(/\\/g, '/');
  if (/^(file|data|blob):/.test(encoded)) {
    return encoded;
  }
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

/** Toolbar button that shows or hides the destination panel */
export const DestinationPanelToggle = observer(() => {
  const { sortStore } = useStore();
  return (
    <ToolbarButton
      id="destination-panel-toggle"
      icon={sortStore.isPanelOpen ? IconSet.FOLDER_OPEN : IconSet.FOLDER_CLOSE}
      onClick={sortStore.togglePanel}
      pressed={sortStore.isPanelOpen}
      text="Sort into folders"
      tooltip="Show the folders you sort files into"
    />
  );
});

/** Moves the dropped files into the folder, if they are files from the library */
async function moveDroppedFiles(rootStore: RootStore, files: FileList, folder: string) {
  const droppedPaths = new Set(Array.from(files, (f) => path.normalize(f.path)));
  const matches: ClientFile[] = runInAction(() =>
    rootStore.fileStore.definedFiles.filter((f) =>
      droppedPaths.has(path.normalize(f.absolutePath)),
    ),
  );
  if (matches.length < droppedPaths.size) {
    AppToaster.show(
      {
        message:
          matches.length === 0
            ? 'Only files from your library can be sorted here'
            : `${
                droppedPaths.size - matches.length
              } dropped files are not in your library and were skipped`,
        timeout: 6000,
        type: 'warning',
      },
      'destination-drop',
    );
  }
  await rootStore.moveStore.moveFilesTo(matches, folder);
}

/** Makes an element a drop target that moves files into the given folder */
function useFolderDrop(folder: string, onHoverLong?: () => void) {
  const rootStore = useStore();
  const [isTarget, setIsTarget] = useState(false);
  const hoverTimer = useRef<number>();

  const stopTimer = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
  };
  useEffect(() => stopTimer, []);

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // The drag is started natively (so files can also be dragged out of Allusion),
    // which only permits the "copy" effect: the file is moved nevertheless.
    e.dataTransfer.dropEffect = 'copy';
    if (!isTarget) {
      setIsTarget(true);
      if (onHoverLong && hoverTimer.current === undefined) {
        hoverTimer.current = window.setTimeout(onHoverLong, HOVER_TIME_TO_EXPAND);
      }
    }
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
      return;
    }
    setIsTarget(false);
    stopTimer();
  };

  const onDrop = (e: React.DragEvent) => {
    setIsTarget(false);
    stopTimer();
    if (e.dataTransfer.files.length === 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    moveDroppedFiles(rootStore, e.dataTransfer.files, folder).catch(console.error);
  };

  return { isTarget, handlers: { onDragEnter: onDragOver, onDragOver, onDragLeave, onDrop } };
}

type Editing = { mode: 'create'; parent: string } | { mode: 'rename'; folder: string } | undefined;

const NameInput = ({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) => {
  const done = useRef(false);
  const finish = (value: string | undefined) => {
    if (done.current) {
      return;
    }
    done.current = true;
    value !== undefined && value.trim().length > 0 ? onSubmit(value) : onCancel();
  };
  return (
    <input
      className="input destination-name-input"
      autoFocus
      defaultValue={initial}
      placeholder="Folder name"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value !== initial ? e.currentTarget.value : undefined)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          finish(undefined);
        }
      }}
    />
  );
};

const Swatch = ({ color }: { color: string | undefined }) => (
  <span className="destination-swatch" style={{ background: color }} />
);

/** Opens the colour picker of the system */
function pickCustomColor(initial: string | undefined, onPick: (color: string) => void) {
  const id = 'destination-color-input';
  document.getElementById(id)?.remove();
  const el = document.createElement('input');
  el.id = id;
  el.type = 'color';
  el.value = initial !== undefined && /^#[0-9a-f]{6}$/i.test(initial) ? initial : '#888888';
  el.style.cssText = 'position:fixed;left:50%;top:40%;width:0;height:0;opacity:0;';
  el.addEventListener('change', () => {
    onPick(el.value);
    el.remove();
  });
  document.body.appendChild(el);
  el.click();
}

/** The context menu of a folder, shared by the tree rows and the tiles */
function useFolderMenu(node: FolderNode, isRoot: boolean, setEditing: (e: Editing) => void) {
  const { sortStore, moveStore, uiStore } = useStore();
  const show = useContextMenu();
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const selection = runInAction(() => Array.from(uiStore.fileSelection));
    const pinnedKey = sortStore.pinOf(node.path);
    show(
      e.clientX,
      e.clientY,
      <Menu>
        <MenuItem
          text={
            selection.length > 0
              ? `Move ${selection.length} Selected File${selection.length === 1 ? '' : 's'} Here`
              : 'Move Selected Files Here'
          }
          icon={IconSet.ARROW_RIGHT}
          disabled={selection.length === 0}
          onClick={() => moveStore.moveFilesTo(selection, node.path)}
        />
        <MenuDivider />
        <MenuItem
          text="New Subfolder"
          icon={IconSet.PLUS}
          onClick={() => {
            sortStore.toggleExpansion(node.path, true);
            setEditing({ mode: 'create', parent: node.path });
          }}
        />
        {!isRoot && (
          <MenuItem
            text="Rename"
            icon={IconSet.EDIT}
            onClick={() => setEditing({ mode: 'rename', folder: node.path })}
          />
        )}
        <MenuSubItem text="Colour" icon={<Swatch color={sortStore.colorOf(node.path)} />}>
          {FOLDER_COLORS.map(([name, color]) => (
            <MenuItem
              key={color}
              text={name}
              icon={<Swatch color={color} />}
              onClick={() => sortStore.setColor(node.path, color)}
            />
          ))}
          <MenuItem
            text="Other Colour..."
            icon={IconSet.EDIT}
            onClick={() =>
              pickCustomColor(sortStore.colorOf(node.path), (color) =>
                sortStore.setColor(node.path, color),
              )
            }
          />
          <MenuItem
            text="No Colour"
            icon={IconSet.CLOSE}
            disabled={!sortStore.colors.has(node.path)}
            onClick={() => sortStore.setColor(node.path, undefined)}
          />
        </MenuSubItem>
        <MenuSubItem text="Number Key" icon={IconSet.PLUS}>
          {Array.from({ length: PIN_SLOTS }, (_, i) => {
            const taken = sortStore.pins[i];
            return (
              <MenuItem
                key={i}
                text={`${i + 1}${taken ? `  (now: ${path.basename(taken)})` : ''}`}
                onClick={() => sortStore.pin(node.path, i + 1)}
              />
            );
          })}
          <MenuItem
            text="No Number Key"
            icon={IconSet.CLOSE}
            disabled={pinnedKey === undefined}
            onClick={() => pinnedKey !== undefined && sortStore.unpinKey(pinnedKey)}
          />
        </MenuSubItem>
        <MenuItem
          text="Show Files Directly in This Folder"
          icon={IconSet.SEARCH}
          onClick={() => sortStore.showLooseFiles(node.path)}
        />
        <MenuItem
          text="Reveal in File Browser"
          icon={IconSet.FOLDER_CLOSE}
          onClick={() => shell.showItemInFolder(node.path)}
        />
        {isRoot && (
          <>
            <MenuDivider />
            <MenuItem
              text="Remove from Destinations"
              icon={IconSet.CLOSE}
              onClick={() => sortStore.removeRoot(node.path)}
            />
            <MenuItem
              text="Remove All Destinations..."
              icon={IconSet.CLOSE}
              onClick={() => sortStore.removeAllRoots()}
            />
          </>
        )}
      </Menu>,
    );
  };
}

/** Shows the number key a folder is assigned to */
const PinBadge = observer(({ folder }: { folder: string }) => {
  const { sortStore } = useStore();
  const key = sortStore.pinOf(folder);
  return key === undefined ? null : (
    <kbd className="destination-pin" data-tooltip={`Press M, then ${key} to move files here`}>
      {key}
    </kbd>
  );
});

/** Shows how many files are in a folder */
const FolderCount = observer(({ folder }: { folder: string }) => {
  const { sortStore } = useStore();
  const count = sortStore.folderCounts.get(folder);
  return count === undefined ? null : (
    <span className="destination-count" data-tooltip="Files in this folder and its sub folders">
      {count.toLocaleString()}
    </span>
  );
});

interface FolderRowProps {
  node: FolderNode;
  depth: number;
  isRoot: boolean;
  /** When filtering, all folders are shown expanded */
  forceExpanded: boolean;
  editing: Editing;
  setEditing: (editing: Editing) => void;
  /** False in the tile view, where sub folders are shown as tiles instead */
  showChildren?: boolean;
}

const FolderRow = observer(
  ({
    node,
    depth,
    isRoot,
    forceExpanded,
    editing,
    setEditing,
    showChildren = true,
  }: FolderRowProps) => {
    const { sortStore } = useStore();
    const isExpanded = showChildren && (forceExpanded || sortStore.expanded.has(node.path));
    const expand = useCallback(
      () => sortStore.toggleExpansion(node.path, true),
      [sortStore, node.path],
    );
    // No expanding on hover when the tree is locked
    const { isTarget, handlers } = useFolderDrop(
      node.path,
      sortStore.isLocked || !showChildren ? undefined : expand,
    );
    const looseCount = isRoot ? sortStore.looseCounts.get(node.path) : undefined;
    const color = sortStore.colorOf(node.path);
    const isRenaming = editing?.mode === 'rename' && editing.folder === node.path;
    const isCreatingChild = editing?.mode === 'create' && editing.parent === node.path;
    const hasChildren = showChildren && node.children.length > 0;

    const handleContextMenu = useFolderMenu(node, isRoot, setEditing);

    return (
      <>
        <div
          className={`destination-row${isRoot ? ' destination-root' : ''}`}
          data-dnd-target={isTarget}
          style={{
            paddingLeft: `${0.25 + depth * 0.9}rem`,
            boxShadow: color ? `inset 3px 0 0 ${color}` : undefined,
          }}
          title={node.path}
          onClick={showChildren ? () => sortStore.toggleExpansion(node.path) : undefined}
          onContextMenu={handleContextMenu}
          {...handlers}
        >
          <span className={`destination-caret${hasChildren ? '' : ' hidden'}`}>
            {isExpanded ? IconSet.ARROW_DOWN : IconSet.ARROW_RIGHT}
          </span>
          {isExpanded && hasChildren ? IconSet.FOLDER_OPEN : IconSet.FOLDER_CLOSE}
          {isRenaming ? (
            <NameInput
              initial={node.name}
              onSubmit={(name) => {
                setEditing(undefined);
                sortStore.renameFolder(node.path, name);
              }}
              onCancel={() => setEditing(undefined)}
            />
          ) : (
            <span className="destination-name">
              {isRoot ? sortStore.rootLabel(node.path) : node.name}
            </span>
          )}
          <PinBadge folder={node.path} />
          <FolderCount folder={node.path} />
          {looseCount !== undefined && looseCount > 0 && (
            <button
              className="destination-loose"
              data-tooltip="Files directly in this folder, not in a sub folder. Click to show them."
              onClick={(e) => {
                e.stopPropagation();
                sortStore.showLooseFiles(node.path);
              }}
            >
              {looseCount.toLocaleString()} loose
            </button>
          )}
        </div>
        {isCreatingChild && (
          <div
            className="destination-row"
            style={{ paddingLeft: `${0.25 + (depth + 1) * 0.9}rem` }}
          >
            <span className="destination-caret hidden">{IconSet.ARROW_RIGHT}</span>
            {IconSet.FOLDER_CLOSE}
            <NameInput
              initial=""
              onSubmit={(name) => {
                setEditing(undefined);
                sortStore.createFolder(node.path, name);
              }}
              onCancel={() => setEditing(undefined)}
            />
          </div>
        )}
        {isExpanded &&
          node.children.map((child) => (
            <FolderRow
              key={child.path}
              node={child}
              depth={depth + 1}
              isRoot={false}
              forceExpanded={forceExpanded}
              editing={editing}
              setEditing={setEditing}
            />
          ))}
      </>
    );
  },
);

/** A sub folder shown as a large drop target, for the tile view */
const FolderTile = observer(
  ({
    node,
    editing,
    setEditing,
  }: {
    node: FolderNode;
    editing: Editing;
    setEditing: (editing: Editing) => void;
  }) => {
    const { sortStore } = useStore();
    const { isTarget, handlers } = useFolderDrop(node.path);
    const handleContextMenu = useFolderMenu(node, false, setEditing);
    const color = sortStore.colorOf(node.path);
    const thumb = sortStore.thumbs.get(node.path);
    const isRenaming = editing?.mode === 'rename' && editing.folder === node.path;
    return (
      <div
        className={`destination-tile${thumb ? ' has-thumb' : ''}`}
        style={{
          borderBottomColor: color,
          backgroundImage: thumb
            ? `linear-gradient(transparent 30%, rgba(0, 0, 0, 0.85)), url("${toCssUrl(thumb)}")`
            : undefined,
        }}
        data-dnd-target={isTarget}
        title={node.path}
        // A folder with sub folders opens, to show those as tiles
        onClick={node.children.length > 0 ? () => sortStore.setTileFolder(node.path) : undefined}
        onContextMenu={handleContextMenu}
        {...handlers}
      >
        {IconSet.FOLDER_CLOSE}
        {isRenaming ? (
          <NameInput
            initial={node.name}
            onSubmit={(name) => {
              setEditing(undefined);
              sortStore.renameFolder(node.path, name);
            }}
            onCancel={() => setEditing(undefined)}
          />
        ) : (
          <span className="destination-name">{node.name}</span>
        )}
        <PinBadge folder={node.path} />
        <span className="destination-tile-info">
          {sortStore.folderCounts.get(node.path)?.toLocaleString()}
          {node.children.length > 0 && ` · ${node.children.length} sub folders ›`}
        </span>
      </div>
    );
  },
);

const RecentChip = ({ folder }: { folder: string }) => {
  const { isTarget, handlers } = useFolderDrop(folder);
  return (
    <span className="destination-recent" data-dnd-target={isTarget} title={folder} {...handlers}>
      {path.basename(folder)}
    </span>
  );
};

/** Keeps only the folders that match the filter, together with their parent folders */
function filterTree(node: FolderNode, query: string, isRoot = true): FolderNode | undefined {
  const children = node.children
    .map((c) => filterTree(c, query, false))
    .filter((c): c is FolderNode => c !== undefined);
  if (children.length > 0 || (!isRoot && fuzzyScore(query, node.name) > 0)) {
    return { ...node, children };
  }
  return undefined;
}

const DestinationPanel = observer(() => {
  const { sortStore, moveStore, fileStore, uiStore } = useStore();
  const [editing, setEditing] = useState<Editing>(undefined);
  const [showHistory, setShowHistory] = useState(false);
  const panel = useRef<HTMLElement>(null);

  // Folders may have been changed outside of Allusion: re-read them when coming back to the window
  useEffect(() => {
    if (!sortStore.isPanelOpen) {
      return;
    }
    const refresh = () => sortStore.refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [sortStore, sortStore.isPanelOpen]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const right = panel.current?.getBoundingClientRect().right ?? window.innerWidth;
      const onMove = (ev: MouseEvent) => sortStore.setPanelWidth(right - ev.clientX);
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sortStore],
  );

  const filter = sortStore.filter.trim();
  const visibleTrees = sortStore.visibleTrees;
  const trees = useMemo(
    () =>
      filter.length === 0
        ? visibleTrees
        : visibleTrees
            .map((t) => filterTree(t, filter))
            .filter((t): t is FolderNode => t !== undefined),
    [visibleTrees, filter],
  );

  if (!sortStore.isPanelOpen) {
    return null;
  }

  const { roots, recentDestinations, unsortedCount } = sortStore;
  // The folder that was opened in the tile view, to show its sub folders as tiles
  const opened =
    sortStore.viewMode === 'tiles' && sortStore.tileFolder !== null
      ? sortStore.getNode(sortStore.tileFolder)
      : undefined;
  const history = moveStore.history.slice(-20).reverse();

  return (
    <aside id="destination-panel" ref={panel} style={{ width: sortStore.panelWidth }}>
      <div className="destination-resizer" onMouseDown={startResize} />
      <header>
        <h2>Sort into</h2>
        {unsortedCount !== undefined && (
          <button
            className="destination-counter"
            onClick={sortStore.showUnsorted}
            data-tooltip="Show the files that are not in a category folder yet"
          >
            {unsortedCount.toLocaleString()} left
          </button>
        )}
        <span className="spacer" />
        <button
          className="destination-toggle"
          aria-pressed={sortStore.isLocked}
          data-tooltip="When locked, folders do not open while you drag files over them"
          onClick={sortStore.toggleLock}
        >
          {sortStore.isLocked ? 'Locked' : 'Lock'}
        </button>
        <IconButton
          icon={sortStore.viewMode === 'tree' ? IconSet.VIEW_GRID : IconSet.VIEW_LIST}
          text={sortStore.viewMode === 'tree' ? 'Show folders as tiles' : 'Show folders as tree'}
          onClick={sortStore.toggleViewMode}
        />
        <IconButton
          icon={IconSet.RELOAD}
          text="Re-read folders from disk"
          onClick={sortStore.refresh}
        />
        <IconButton
          icon={IconSet.PLUS}
          text="Add a folder to sort files into"
          onClick={() => sortStore.addRootWithDialog()}
        />
        <IconButton icon={IconSet.CLOSE} text="Close panel" onClick={sortStore.togglePanel} />
      </header>
      <div className="destination-view-actions">
        {moveStore.movedMarks.size > 0 && (
          <button
            data-tooltip="Reload the gallery, so the greyed out files disappear"
            onClick={() => moveStore.tidyUp()}
          >
            Tidy up ({moveStore.movedMarks.size})
          </button>
        )}
        <button
          data-tooltip="Go to the first file of the gallery"
          onClick={async () => {
            await fileStore.jumpToFirst();
            window.setTimeout(() => uiStore.setFirstItem(0), 200);
          }}
        >
          Back to top
        </button>
      </div>

      {roots.length === 0 ? (
        <div className="destination-empty">
          <p>
            Add the folders you sort your references into. Their subfolders show up here, and
            dropping files on one moves them there.
          </p>
          <button className="btn btn-solid" onClick={() => sortStore.addRootWithDialog()}>
            Add destination folder
          </button>
        </div>
      ) : (
        <>
          {roots.length > 1 && (
            <div className="destination-tabs">
              <button
                aria-pressed={sortStore.activeRoot === null}
                onClick={() => sortStore.setActiveRoot(null)}
              >
                All
              </button>
              {roots.map((root) => (
                <button
                  key={root}
                  aria-pressed={sortStore.activeRoot === root}
                  title={root}
                  onClick={() => sortStore.setActiveRoot(root)}
                >
                  {sortStore.rootLabel(root)}
                </button>
              ))}
            </div>
          )}

          <input
            className="input destination-filter"
            type="text"
            placeholder="Filter folders..."
            value={sortStore.filter}
            onChange={(e) => sortStore.setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                sortStore.setFilter('');
                e.currentTarget.blur();
              }
            }}
          />

          {recentDestinations.length > 0 && (
            <div className="destination-recents">
              <span className="destination-label">Recent</span>
              {recentDestinations.map((folder) => (
                <RecentChip key={folder} folder={folder} />
              ))}
            </div>
          )}

          <div className="destination-tree">
            {opened && (
              <>
                <div
                  className="destination-row destination-back"
                  onClick={() => sortStore.setTileFolder(path.dirname(opened.path))}
                >
                  {IconSet.ARROW_LEFT}
                  <span className="destination-name">Back</span>
                </div>
                <FolderRow
                  node={opened}
                  depth={0}
                  isRoot={false}
                  forceExpanded={false}
                  editing={editing}
                  setEditing={setEditing}
                  showChildren={false}
                />
                <div className="destination-tiles">
                  {opened.children.map((child) => (
                    <FolderTile
                      key={child.path}
                      node={child}
                      editing={editing}
                      setEditing={setEditing}
                    />
                  ))}
                </div>
              </>
            )}
            {!opened &&
              trees.map((tree) =>
                sortStore.viewMode === 'tree' ? (
                  <FolderRow
                    key={tree.path}
                    node={tree}
                    depth={0}
                    isRoot
                    forceExpanded={filter.length > 0}
                    editing={editing}
                    setEditing={setEditing}
                  />
                ) : (
                  <React.Fragment key={tree.path}>
                    <FolderRow
                      node={tree}
                      depth={0}
                      isRoot
                      forceExpanded={false}
                      editing={editing}
                      setEditing={setEditing}
                      showChildren={false}
                    />
                    <div className="destination-tiles">
                      {tree.children.map((child) => (
                        <FolderTile
                          key={child.path}
                          node={child}
                          editing={editing}
                          setEditing={setEditing}
                        />
                      ))}
                    </div>
                  </React.Fragment>
                ),
              )}
            {trees.length === 0 && (
              <p className="destination-empty">
                {filter.length > 0 ? 'No folder matches the filter.' : 'Folder not found on disk.'}
              </p>
            )}
          </div>

          <footer>
            <p>
              Drop files on a folder to move them, or press <kbd>M</kbd> to sort with the keyboard.
              Right-click a folder for more.
            </p>
            <label data-tooltip='Otherwise the moved file gets a new name, like "name (1)", and both are kept'>
              <input
                type="checkbox"
                checked={moveStore.askOnCollision}
                onChange={moveStore.toggleAskOnCollision}
              />
              Ask when a file name is already taken
            </label>
            <div className="destination-footer-actions">
              <button aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>
                History
              </button>
              <button onClick={() => sortStore.removeAllRoots()}>Remove all destinations</button>
            </div>
            {showHistory && (
              <div className="destination-history">
                {history.length === 0 && <p>No files were moved yet.</p>}
                {history.map((batch) => (
                  <div key={batch.id} className={batch.undone ? 'undone' : undefined}>
                    <span title={batch.records.map((r) => path.basename(r.to)).join('\n')}>
                      {new Date(batch.date).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · {batch.records.length} → {path.basename(batch.destination)}
                    </span>
                    <button onClick={() => moveStore.toggleBatch(batch.id)}>
                      {batch.undone ? 'Redo' : 'Undo'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </footer>
        </>
      )}
    </aside>
  );
});

export default DestinationPanel;
