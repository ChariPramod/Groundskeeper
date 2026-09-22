"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
      <h1>Let’s get you back to the garden.</h1>
      <p>This view couldn’t load. Your stored reports haven’t changed.</p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
