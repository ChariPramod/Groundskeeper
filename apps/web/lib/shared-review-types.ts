export interface SharedReviewFields {
  owner: string;
  note: string;
  dismissed: boolean;
}
export interface SharedReviewData extends SharedReviewFields {
  runId: string;
  version: number;
  updatedAt: string | null;
  events: (SharedReviewFields & {
    version: number;
    actorGithubUserId: string;
    actorLogin: string;
    createdAt: string;
  })[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const version = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const fields = (v: Record<string, unknown>) =>
  typeof v.owner === "string" &&
  v.owner.length <= 100 &&
  typeof v.note === "string" &&
  v.note.length <= 2000 &&
  typeof v.dismissed === "boolean";
export function isSharedReviewData(v: unknown): v is SharedReviewData {
  return (
    object(v) &&
    typeof v.runId === "string" &&
    /^[A-Za-z0-9_-]{1,200}$/.test(v.runId) &&
    version(v.version) &&
    fields(v) &&
    (v.updatedAt === null || date(v.updatedAt)) &&
    Array.isArray(v.events) &&
    v.events.length <= 20 &&
    v.events.every(
      (e) =>
        object(e) &&
        version(e.version) &&
        Number(e.version) > 0 &&
        Number(e.version) <= Number(v.version) &&
        fields(e) &&
        typeof e.actorGithubUserId === "string" &&
        /^[1-9]\d{0,18}$/.test(e.actorGithubUserId) &&
        typeof e.actorLogin === "string" &&
        /^[A-Za-z0-9-]{1,39}$/.test(e.actorLogin) &&
        date(e.createdAt),
    )
  );
}
