import { dashboardResponse } from "../../../lib/dashboard-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return dashboardResponse(request);
}
