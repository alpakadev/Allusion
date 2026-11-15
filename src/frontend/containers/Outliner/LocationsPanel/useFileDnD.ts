import { useCallback, useState } from 'react';

import { AppToaster } from '../../../components/Toaster';
import { useStore } from '../../../contexts/StoreContext';
import { DnDAttribute } from '../../../contexts/TagDnDContext';
import { IExpansionState } from '../../types';
import {
  findDroppedFileMatches,
  getDropData,
  handleDragLeave,
  isAcceptableType,
  onDragOver,
  storeDroppedImage,
} from './dnd';

export const HOVER_TIME_TO_EXPAND = 600;

export const useFileDropHandling = (
  expansionId: string,
  fullPath: string,
  expansion: IExpansionState,
  setExpansion: (s: IExpansionState) => void,
) => {
  const { fileStore, moveStore } = useStore();
  // Don't expand immediately, only after hovering over it for a second or so
  const [expandTimeoutId, setExpandTimeoutId] = useState<number>();
  const expandDelayed = useCallback(() => {
    if (expandTimeoutId) {
      clearTimeout(expandTimeoutId);
    }
    const t = window.setTimeout(() => {
      setExpansion({ ...expansion, [expansionId]: true });
    }, HOVER_TIME_TO_EXPAND);
    setExpandTimeoutId(t);
  }, [expandTimeoutId, expansion, expansionId, setExpansion]);

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      // Skip events intended for different handlers
      if (!event.dataTransfer.types.includes('Files')) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      const canDrop = onDragOver(event);
      if (canDrop && !expansion[expansionId]) {
        expandDelayed();
      }
    },
    [expansion, expansionId, expandDelayed],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.currentTarget.dataset[DnDAttribute.Target] = 'false';

      if (isAcceptableType(event)) {
        event.dataTransfer.dropEffect = 'none';
        try {
          const dropData = await getDropData(event);

          // if this is a local file (it has matches to the files in the DB),
          // it should be moved instead of copied
          const matches = findDroppedFileMatches(dropData, fileStore);
          if (matches) {
            // Moving is handled by the MoveStore: verified moves, DB stays in sync, undo-able
            await moveStore.moveFilesTo(matches, fullPath);
          } else {
            // Otherwise it's an external file (e.g. from the web or a folder not set up as a Location in Allusion)
            // -> download it and "copy" it to the target folder
            await storeDroppedImage(dropData, fullPath);
          }
        } catch (e) {
          console.error(e);
          AppToaster.show({
            message: 'Something went wrong, could not import image :(',
            timeout: 4000,
          });
        }
      } else {
        AppToaster.show({ message: 'File type not supported :(', timeout: 4000 });
      }
    },
    [fullPath],
  );

  const handleDragLeaveWrapper = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      // Drag events are also triggered for children??
      // We don't want to detect dragLeave of a child as a dragLeave of the target element, so return immmediately
      if ((event.target as HTMLElement).contains(event.relatedTarget as HTMLElement)) {
        return;
      }

      // Skip events intended for different handlers
      if (!event.dataTransfer.types.includes('Files')) {
        return;
      }

      event.stopPropagation();
      event.preventDefault();
      handleDragLeave(event);
      if (expandTimeoutId) {
        clearTimeout(expandTimeoutId);
        setExpandTimeoutId(undefined);
      }
    },
    [expandTimeoutId],
  );

  return {
    handleDragEnter,
    handleDrop,
    handleDragLeave: handleDragLeaveWrapper,
  };
};
