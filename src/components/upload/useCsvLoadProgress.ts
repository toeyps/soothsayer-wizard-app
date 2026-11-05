import { useEffect, useRef, useState } from 'react';
import { subscribe } from '../../utils/tauriEvents';
import type { CsvLoadProgress } from '../../types/dataUpload';
import { isCsvLoadProgress, progressRank } from './setupHelpers';

/** Latest `csv-load-progress` event of this page's own parse; counted only while `active` (the event is a global broadcast), cleared when `active` flips. An older event arriving after a newer one never moves the bar backwards. Subscribes once via `subscribe()`, reads `active` through a ref. */
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
