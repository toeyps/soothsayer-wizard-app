import { useEffect, useRef, useState } from 'react';
import { subscribe } from '../../utils/tauriEvents';
import type { CsvLoadProgress } from '../../types/dataUpload';
import { isCsvLoadProgress, progressRank } from './setupHelpers';

/**
 * Latest `csv-load-progress` event of THIS page's own parse.
 *
 * The event is a global broadcast and `load_csv` also runs for other reasons
 * (opening a recent project), so events are only taken while `active` is true
 * (the Parse button's own load is running); anything arriving otherwise is
 * ignored. The state is cleared every time `active` flips, so a finished parse
 * never leaves a stale bar behind, and an older event that arrives after a
 * newer one (the IPC channel does not guarantee order) never moves the bar
 * backwards.
 *
 * Subscribes once through `subscribe()` (synchronous, leak-proof cleanup) and
 * reads `active` through a ref instead of re-subscribing.
 */
export function useCsvLoadProgress(active: boolean): CsvLoadProgress | null {
  const [progress, setProgress] = useState<CsvLoadProgress | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const off = subscribe<CsvLoadProgress>('csv-load-progress', (event) => {
      if (!activeRef.current) return;
      const next = event.payload;
      if (!isCsvLoadProgress(next)) return;
      setProgress((prev) => (prev && progressRank(next) < progressRank(prev) ? prev : next));
    });
    return off;
  }, []);

  useEffect(() => {
    setProgress(null);
  }, [active]);

  return active ? progress : null;
}
