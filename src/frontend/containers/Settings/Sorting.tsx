import { observer } from 'mobx-react-lite';
import React from 'react';

import { Button } from 'widgets';
import { Toggle } from 'widgets/checkbox';
import { useStore } from '../../contexts/StoreContext';

/** Settings for sorting files into folders, and the programs of the "Open With" menu */
export const Sorting = observer(() => {
  const { sortStore, moveStore } = useStore();

  return (
    <>
      <h3>Moving files</h3>
      <div className="vstack">
        <Toggle checked={moveStore.askOnCollision} onChange={moveStore.toggleAskOnCollision}>
          Ask when a file with the same name exists in the folder (otherwise the moved file gets a
          new name, like &quot;name (1)&quot;, and both are kept)
        </Toggle>
        <Toggle checked={sortStore.isQuickMoveSticky} onChange={sortStore.toggleQuickMoveSticky}>
          Keep the keyboard box open after a move, to sort one file after the other
        </Toggle>
      </div>

      <h3>Destination panel</h3>
      <div className="vstack">
        <Toggle checked={sortStore.isLocked} onChange={sortStore.toggleLock}>
          Do not open folders while files are dragged over them
        </Toggle>
        <Toggle checked={sortStore.viewMode === 'tiles'} onChange={sortStore.toggleViewMode}>
          Show sub folders as tiles with a picture
        </Toggle>
      </div>

      <h3>Destination folders</h3>
      <p>The folders you sort files into. Removing one here does not touch the folder itself.</p>
      <div className="vstack">
        {sortStore.roots.length === 0 && <i>No destination folders yet.</i>}
        {sortStore.roots.map((root) => (
          <div key={root} className="hstack">
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{root}</span>
            <Button styling="outlined" text="Remove" onClick={() => sortStore.removeRoot(root)} />
          </div>
        ))}
        <div className="hstack">
          <Button
            styling="outlined"
            text="Add folder..."
            onClick={() => sortStore.addRootWithDialog()}
          />
          {sortStore.roots.length > 0 && (
            <Button
              styling="outlined"
              text="Remove all..."
              onClick={() => sortStore.removeAllRoots()}
            />
          )}
        </div>
      </div>

      <h3>Programs for &quot;Open With&quot;</h3>
      <p>
        Programs offered in the file menu under &quot;Open With&quot;, for example an image editor.
      </p>
      <div className="vstack">
        {sortStore.externalApps.length === 0 && <i>No programs yet.</i>}
        {sortStore.externalApps.map((app) => (
          <div key={app.path} className="hstack">
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} title={app.path}>
              {app.name}
            </span>
            <Button
              styling="outlined"
              text="Remove"
              onClick={() => sortStore.removeExternalApp(app.path)}
            />
          </div>
        ))}
        <div className="hstack">
          <Button
            styling="outlined"
            text="Add program..."
            onClick={() => sortStore.addExternalAppWithDialog()}
          />
        </div>
      </div>
    </>
  );
});
