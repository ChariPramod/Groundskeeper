import { teamManagementResponse } from "../../../lib/team-management-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return teamManagementResponse(request);
}
export async function PUT(request: Request) {
  return teamManagementResponse(request);
}
