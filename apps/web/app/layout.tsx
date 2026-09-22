import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Groundskeeper · Documentation, tended.",
  description:
    "A calm workspace for documentation drift, verification evidence, and repository health.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
