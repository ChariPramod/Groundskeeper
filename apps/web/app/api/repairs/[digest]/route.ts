import { repairReviewResponse } from "../../../../lib/repair-review";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ digest: string }> }) {
  return repairReviewResponse(request, (await params).digest);
}
