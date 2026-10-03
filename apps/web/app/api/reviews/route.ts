import { reviewInboxResponse } from "../../../lib/review-inbox-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return reviewInboxResponse(request);
}
