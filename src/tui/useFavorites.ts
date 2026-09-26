import { useEffect, useState } from "react";
import { readFavorites, toggleFavorite, type FavoriteKind } from "../favorites.js";

/**
 * Marked entries of one list, stored per project. `reload` re-reads them,
 * e.g. when the session changes.
 */
export function useFavorites(cwd: string, kind: FavoriteKind, reload?: unknown) {
  const [marks, setMarks] = useState<string[]>(() => readFavorites(cwd, kind));

  useEffect(() => {
    setMarks(readFavorites(cwd, kind));
  }, [cwd, kind, reload]);

  return {
    marks,
    isMarked: (id: string | undefined) => id !== undefined && marks.includes(id),
    toggle: (id: string) => setMarks(toggleFavorite(cwd, kind, id)),
  };
}
