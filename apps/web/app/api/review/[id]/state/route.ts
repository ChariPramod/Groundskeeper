import { sharedReviewResponse } from "../../../../../lib/shared-review-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return sharedReviewResponse(request, (await params).id);
}
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return sharedReviewResponse(request, (await params).id);
}
