import { observer } from 'mobx-react-lite';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../../contexts/StoreContext';
import { fuzzyScore } from '../../move/fuzzy';
import { FolderEntry } from '../../stores/SortStore';

const MAX_RESULTS = 30;
const BOX_KEY = 'quick-move-box';

/** Where the bar was put and how large it was made, in pixels relative to the content area */
type Box = { left: number; top: number; width: number; height: number };

function loadBox(): Box | undefined {
  try {
    const box = JSON.parse(localStorage.getItem(BOX_KEY) ?? 'null');
    return box && typeof box.left === 'number' ? box : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keyboard sorting: a small box that floats over the content, so the files stay visible.
 * - Tab switches between the destinations, so only the folders of one of them are offered.
 * - Type a few letters of a folder name and press Enter to move the selected files there.
 * - While nothing is typed, the number keys move the files to the folders assigned to them,
 *   and the left and right arrow keys go to the previous or next file without moving it.
 * After a move the next file is selected. When "Keep open" is on, the box stays ready for it.
 */
const QuickMoveBar = observer(() => {
  const { sortStore, moveStore, uiStore } = useStore();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | undefined>(loadBox);
  // A press inside the box takes the focus from the text field: that must not close the box
  const isPressedInside = useRef(false);

  /** Reads the place and size of the box, kept inside the content area */
  const measure = (left?: number, top?: number): Box | undefined => {
    const el = bar.current;
    const parent = el?.offsetParent;
    if (!el || !parent) {
      return undefined;
    }
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
    return {
      left: clamp(left ?? el.offsetLeft, parent.clientWidth - width),
      top: clamp(top ?? el.offsetTop, parent.clientHeight - height),
      width,
      height,
    };
  };

  const saveBox = (next: Box | undefined) => {
    if (next) {
      setBox(next);
      localStorage.setItem(BOX_KEY, JSON.stringify(next));
    }
  };

  // Drag the header to move the box
  const startDrag = (e: React.MouseEvent) => {
    const el = bar.current;
    if (!el || (e.target as HTMLElement).closest('button')) {
      return;
    }
    const startLeft = el.offsetLeft;
    const startTop = el.offsetTop;
    const { clientX, clientY } = e;
    const onMove = (ev: MouseEvent) =>
      setBox(measure(startLeft + ev.clientX - clientX, startTop + ev.clientY - clientY));
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      saveBox(measure(startLeft + ev.clientX - clientX, startTop + ev.clientY - clientY));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // The box starts in the corner. From then on it is placed by its top left corner,
  // so that resizing moves the corner that is dragged and nothing else.
  useLayoutEffect(() => {
    if (!box) {
      setBox(measure());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag the bottom right corner to resize the box: the corner follows the mouse exactly
  const startResize = (e: React.MouseEvent) => {
    const el = bar.current;
    const parent = el?.offsetParent;
    if (!el || !parent) {
      return;
    }
    e.preventDefault();
    const left = el.offsetLeft;
    const top = el.offsetTop;
    const startWidth = el.offsetWidth;
    const startHeight = el.offsetHeight;
    const { clientX, clientY } = e;
    const sized = (ev: MouseEvent): Box => ({
      left,
      top,
      width: Math.max(190, Math.min(startWidth + ev.clientX - clientX, parent.clientWidth - left)),
      height: Math.max(72, Math.min(startHeight + ev.clientY - clientY, parent.clientHeight - top)),
    });
    const onMove = (ev: MouseEvent) => setBox(sized(ev));
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      saveBox(sized(ev));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const { quickMoveFocus } = sortStore;
  useEffect(() => input.current?.focus(), [quickMoveFocus]);

  const { folderEntries, recentDestinations, roots, activeRoot } = sortStore;
  const pins = sortStore.resolvedPins;
  const pinKey = pins.join('|');
  const suggested = sortStore.suggestedFolder;
  const results = useMemo(() => {
    const q = query.trim();
    if (q.length === 0) {
      // Nothing typed yet: the folder that was used last comes first, so Enter repeats it.
      // Then the folders with a number key, then the other recently used ones.
      const rank = (e: FolderEntry) => {
        if (e.path === suggested) {
          return -1;
        }
        const pin = pins.indexOf(e.path);
        if (pin !== -1) {
          return pin;
        }
        const recent = recentDestinations.indexOf(e.path);
        return recent !== -1 ? 100 + recent : 1000;
      };
      return folderEntries
        .map((entry, i) => ({ entry, order: rank(entry) * 100000 + i }))
        .sort((a, b) => a.order - b.order)
        .slice(0, MAX_RESULTS)
        .map((r) => r.entry);
    }
    return folderEntries
      .map((entry) => ({
        entry,
        // A match in the folder's own name counts more than one in its parent folders
        score: fuzzyScore(q, entry.name) || fuzzyScore(q, entry.location) * 0.1,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((r) => r.entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, folderEntries, recentDestinations, pinKey, suggested]);

  // A name that no folder has yet can become a new folder: in the active destination,
  // or, while all are shown, in the one of your choice.
  const newName = query.trim();
  const createIn =
    newName.length === 0 ||
    folderEntries.some((e) => e.name.toLowerCase() === newName.toLowerCase())
      ? []
      : activeRoot !== null
      ? [activeRoot]
      : roots.slice();
  const total = results.length + createIn.length;
  const selected = Math.min(index, Math.max(total - 1, 0));
  const count = uiStore.fileSelection.size;
  const firstFile = uiStore.fileSelection.values().next().value as { name: string } | undefined;

  const moveTo = (folder: string | null | undefined) => {
    if (!folder) {
      return;
    }
    setQuery('');
    setIndex(0);
    if (!sortStore.isQuickMoveSticky) {
      sortStore.closeQuickMove();
    }
    moveStore.moveSelectionTo(folder);
  };

  const createAndMove = async (parent: string | undefined) => {
    if (parent === undefined) {
      return;
    }
    const folder = await sortStore.createFolder(parent, newName);
    moveTo(folder);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Keeps the keys away from the gallery and the full-size view
    e.stopPropagation();
    const isEmpty = query.length === 0;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(Math.min(selected + 1, total - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(selected - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mod && createIn.length > 0) {
        // Ctrl+Enter: create the folder without having to go down the list
        createAndMove(createIn[0]);
      } else if (selected >= results.length) {
        createAndMove(createIn[selected - results.length]);
      } else {
        moveTo(results[selected]?.path);
      }
    } else if (e.key === 'Escape') {
      if (isEmpty) {
        sortStore.closeQuickMove();
      } else {
        setQuery('');
        setIndex(0);
      }
    } else if (e.key === 'Tab') {
      // The quickest decision first: which destination the file belongs to
      e.preventDefault();
      sortStore.cycleActiveRoot(e.shiftKey ? -1 : 1);
      setIndex(0);
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? moveStore.redo() : moveStore.undo();
    } else if (isEmpty && e.key === 'Delete') {
      // Straight to the recycle bin, without asking: sorting out is part of sorting
      e.preventDefault();
      moveStore.trashSelection();
    } else if (isEmpty && !mod && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      moveTo(pins[Number(e.key) - 1]);
    } else if (isEmpty && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ')) {
      // Skip: on to the next file (or back) without moving this one
      e.preventDefault();
      sortStore.stepSelection(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };

  const activeColor = activeRoot !== null ? sortStore.colorOf(activeRoot) : undefined;

  return (
    <div
      id="quick-move"
      ref={bar}
      style={{
        ...(box ? { ...box, right: 'auto', bottom: 'auto' } : undefined),
        borderTopColor: activeColor,
      }}
      onMouseDown={() => {
        isPressedInside.current = true;
        // The press may end anywhere, e.g. after dragging or resizing the box
        window.addEventListener(
          'mouseup',
          () => {
            isPressedInside.current = false;
            input.current?.focus();
          },
          { once: true },
        );
      }}
    >
      <header
        onMouseDown={startDrag}
        data-tooltip="Drag to move. Tab: other destination · Enter: move · Ctrl+Enter: new folder · 1-9: numbered folder · Space: skip · Del: recycle bin · ← →: other file · Ctrl+Z: undo · Esc: close"
      >
        <span>Move</span>
        <strong>
          {count === 0 ? 'nothing selected' : count === 1 ? firstFile?.name : `${count} files`}
        </strong>
        <span>to</span>
        <span className="spacer" />
        <button
          aria-pressed={sortStore.isQuickMoveSticky}
          data-tooltip="Stay open after a move, to sort one file after the other"
          onClick={sortStore.toggleQuickMoveSticky}
        >
          Keep open
        </button>
      </header>
      {roots.length > 1 && (
        <div className="quick-move-roots">
          {roots.map((root) => (
            <button
              key={root}
              aria-pressed={activeRoot === root}
              title={root}
              style={{ borderColor: sortStore.colorOf(root) }}
              onClick={() => sortStore.setActiveRoot(root)}
            >
              {sortStore.rootLabel(root)}
            </button>
          ))}
          <button aria-pressed={activeRoot === null} onClick={() => sortStore.setActiveRoot(null)}>
            All
          </button>
          <kbd>Tab</kbd>
        </div>
      )}
      <input
        ref={input}
        className="input"
        type="text"
        placeholder="Type a folder name, or press a number key..."
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setIndex(0);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (!sortStore.isQuickMoveSticky && !isPressedInside.current) {
            sortStore.closeQuickMove();
          }
        }}
      />
      <div className="quick-move-results">
        {results.map((entry, i) => {
          const pin = sortStore.pinOf(entry.path);
          return (
            <div
              key={entry.path}
              className="quick-move-result"
              aria-selected={i === selected}
              title={entry.path}
              // mouseDown instead of click: the input may close the box when it loses focus
              onMouseDown={(e) => {
                e.preventDefault();
                moveTo(entry.path);
              }}
            >
              <span className="quick-move-key">
                {pin !== undefined ? (
                  <kbd>{pin}</kbd>
                ) : (
                  query.length === 0 && entry.path === suggested && <kbd>↵</kbd>
                )}
              </span>
              <span
                className="quick-move-dot"
                style={{ background: sortStore.colorOf(entry.path) }}
              />
              <span>{entry.name}</span>
              <span className="quick-move-path">{entry.location}</span>
            </div>
          );
        })}
        {createIn.map((parent, i) => (
          <div
            key={`create-${parent}`}
            className="quick-move-result quick-move-create"
            aria-selected={results.length + i === selected}
            title={`Create this folder in ${parent} and move the files there`}
            onMouseDown={(e) => {
              e.preventDefault();
              createAndMove(parent);
            }}
          >
            <span className="quick-move-key">+</span>
            <span className="quick-move-dot" style={{ background: sortStore.colorOf(parent) }} />
            <span>New folder &quot;{newName}&quot;</span>
            <span className="quick-move-path">in {sortStore.rootLabel(parent)}</span>
          </div>
        ))}
        {total === 0 && <div className="quick-move-empty">No matching folder</div>}
      </div>
      <div className="quick-move-resizer" onMouseDown={startResize} />
    </div>
  );
});

const QuickMove = observer(() => {
  const { sortStore } = useStore();
  // Mounted only while open, so the search text starts empty each time
  return sortStore.isQuickMoveOpen ? <QuickMoveBar /> : null;
});

export default QuickMove;
