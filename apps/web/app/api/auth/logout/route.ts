import { logoutResponse } from "../../../../lib/team-auth";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return logoutResponse(request);
}
