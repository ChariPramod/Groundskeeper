import { operationsResponse } from "../../../lib/operations-data";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return operationsResponse(request);
}
