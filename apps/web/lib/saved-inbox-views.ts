import type { ReviewInboxFilters } from "./review-inbox-types";

export type SavedInboxView = { name: string; filters: ReviewInboxFilters };
export const MAX_SAVED_VIEWS = 8;
export const savedViewsKey = (scope: string) => `groundskeeper:inbox-views:v1:${scope}`;

/** Treat browser storage as untrusted. Never persist review content or credentials. */
export function decodeSavedViews(raw: string | null): SavedInboxView[] {
  if (raw === null) return [];
  if (raw.length > 16000) throw new Error("Invalid saved views");
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object") throw new Error("Invalid saved views");
  const { version, views } = data as { version?: unknown; views?: unknown };
  if (version !== 1 || !Array.isArray(views) || views.length > MAX_SAVED_VIEWS)
    throw new Error("Invalid saved views");
  const names = new Set<string>();
  return views.map((view: unknown) => {
    if (!view || typeof view !== "object") throw new Error("Invalid saved view");
    const { name, filters } = view as Partial<SavedInboxView>;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 40 ||
      names.has(name.trim().toLowerCase()) ||
      !filters ||
      !["open", "dismissed", "all"].includes(filters.status) ||
      typeof filters.owner !== "string" ||
      filters.owner.length > 100 ||
      typeof filters.repository !== "string" ||
      (filters.repository !== "" &&
        !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(filters.repository)) ||
      typeof filters.unassigned !== "boolean" ||
      (filters.unassigned && filters.owner !== "")
    )
      throw new Error("Invalid saved view");
    names.add(name.trim().toLowerCase());
    return {
      name: name.trim(),
      filters: {
        status: filters.status,
        owner: filters.owner.trim(),
        repository: filters.repository,
        unassigned: filters.unassigned,
      },
    };
  });
}

export function encodeSavedViews(views: SavedInboxView[]) {
  // The same validator bounds reads and writes and strips unexpected fields.
  return JSON.stringify({
    version: 1,
    views: decodeSavedViews(JSON.stringify({ version: 1, views })),
  });
}
