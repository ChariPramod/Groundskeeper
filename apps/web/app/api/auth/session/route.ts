import { sessionResponse } from "../../../../lib/team-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return sessionResponse(request);
}
