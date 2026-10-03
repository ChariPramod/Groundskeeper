import type {
  TeamChangeResult,
  TeamDirectory,
  TeamRole,
} from "@groundskeeper/database/team-management";

export type {
  TeamChange,
  TeamChangeResult,
  TeamDirectory,
  TeamRole,
} from "@groundskeeper/database/team-management";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const role = (value: unknown): value is TeamRole =>
  value === "viewer" || value === "reviewer" || value === "admin";
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9]\d{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const version = (value: unknown): value is number =>
  Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 2147483647;
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export function isTeamDirectory(value: unknown): value is TeamDirectory {
  if (
    !object(value) ||
    !version(value.version) ||
    !Array.isArray(value.members) ||
    value.members.length > 50 ||
    !Array.isArray(value.events) ||
    value.events.length > 20 ||
    !(value.nextCursor === null || id(value.nextCursor))
  )
    return false;
  return (
    value.members.every(
      (member) =>
        object(member) &&
        id(member.githubUserId) &&
        role(member.role) &&
        date(member.createdAt) &&
        (member.lastKnownLogin === null ||
          (typeof member.lastKnownLogin === "string" &&
            /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(member.lastKnownLogin))),
    ) &&
    value.events.every(
      (event) =>
        object(event) &&
        version(event.version) &&
        event.version > 0 &&
        event.version <= (value.version as number) &&
        id(event.githubUserId) &&
        (event.previousRole === null || role(event.previousRole)) &&
        (event.newRole === null || role(event.newRole)) &&
        date(event.createdAt) &&
        object(event.actor) &&
        (event.actor.source === "operator"
          ? event.actor.githubUserId === null && event.actor.login === null
          : event.actor.source === "member" &&
            id(event.actor.githubUserId) &&
            typeof event.actor.login === "string" &&
            /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(event.actor.login)),
    )
  );
}
export function isTeamChangeResult(value: unknown): value is TeamChangeResult {
  return object(value) && version(value.version) && typeof value.changed === "boolean";
}
