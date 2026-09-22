import { Dashboard } from "@/components/dashboard";
import { getDemoDashboard } from "@/lib/demo-data";
export const dynamic = "force-dynamic";
export default function Page() {
  const demo = !process.env.DASHBOARD_MODE || process.env.DASHBOARD_MODE === "demo";
  return <Dashboard initialData={demo ? getDemoDashboard() : null} liveConfigured={!demo} />;
}
