import type { Metadata } from "next";
import { Walkthrough } from "@/components/walkthrough";

export const metadata: Metadata = {
  title: "How Groundskeeper works · Interactive walkthrough",
  description: "Follow a documentation mismatch from code change to a verified repair proposal.",
};
export default function Page() {
  return <Walkthrough />;
}
