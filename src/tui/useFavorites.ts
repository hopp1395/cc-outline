import { useEffect, useState } from "react";
import { clearFavorites, readFavorites, toggleFavorite, type FavoriteKind } from "../favorites.js";
import { useReload } from "./reload.js";

/**
 * Marked entries of one list, stored per project (the settings' globally). `reload` re-reads them,
 * e.g. when the session changes; so does a reload of the view (F5).
 */
export function useFavorites(cwd: string, kind: FavoriteKind, reload?: unknown) {
  const [marks, setMarks] = useState<string[]>(() => readFavorites(cwd, kind));
  const { count } = useReload();

  useEffect(() => {
    setMarks(readFavorites(cwd, kind));
  }, [cwd, kind, reload, count]);

  return {
    marks,
    isMarked: (id: string | undefined) => id !== undefined && marks.includes(id),
    toggle: (id: string) => setMarks(toggleFavorite(cwd, kind, id)),
    clear: () => setMarks(clearFavorites(cwd, kind)),
  };
}
