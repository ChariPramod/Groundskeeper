import { reviewResponse } from "../../../../lib/review-data";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return reviewResponse(request, (await params).id);
}
