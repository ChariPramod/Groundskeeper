"use client";

import { Copy, Download } from "lucide-react";
import { useState } from "react";
import {
  buildInboxExport,
  type InboxExportFormat,
  type InboxExportSnapshot,
} from "../lib/inbox-export";
import { Button } from "./ui/button";

export function InboxExport({
  snapshot,
  stale,
  busy,
}: {
  snapshot: InboxExportSnapshot;
  stale: boolean;
  busy: boolean;
}) {
  const [notice, setNotice] = useState("");
  const [fallback, setFallback] = useState<InboxExportFormat | null>(null);
  // The fallback is derived from current authorized data, never a retained copy of old rows.
  let fallbackContent = "";
  let fallbackError = false;
  if (fallback) {
    try {
      fallbackContent = buildInboxExport(snapshot, fallback, stale).content;
    } catch {
      fallbackError = true;
    }
  }
  function download(format: InboxExportFormat) {
    setFallback(null);
    let url: string | null = null;
    let link: HTMLAnchorElement | null = null;
    try {
      const file = buildInboxExport(snapshot, format, stale);
      url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
      link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      document.body.append(link);
      link.click();
      setNotice(
        `Download requested for page ${snapshot.page + 1}. If it did not start, use Copy instead.`,
      );
    } catch {
      setNotice("Download unavailable. Copy the export below or select its text manually.");
      setFallback(format);
    } finally {
      link?.remove();
      if (url) {
        const objectUrl = url;
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    }
  }
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Export inbox page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Export this page</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {snapshot.data.rows.length} loaded{" "}
            {snapshot.data.rows.length === 1 ? "review" : "reviews"} · Applied filters · Note
            snippets only
            {stale ? " · Last successful snapshot" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => download("csv")}>
            <Download /> Export CSV
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => download("json")}>
            <Download /> Export JSON
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setFallback("json");
              setNotice("");
            }}
          >
            <Copy /> Copy instead
          </Button>
        </div>
      </div>
      {notice && !fallbackError && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {fallbackError && (
        <p role="alert" className="mt-3 text-sm text-amber-800">
          This inbox snapshot cannot be exported. Refresh the inbox and try again.
        </p>
      )}
      {fallback && !fallbackError && (
        <div className="mt-3">
          <label className="text-xs font-medium">
            {fallback.toUpperCase()} export · page {snapshot.page + 1}
            <textarea
              readOnly
              value={fallbackContent}
              className="mt-2 h-40 w-full rounded-lg border border-input bg-background p-3 font-mono text-xs"
              onFocus={(event) => event.target.select()}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(fallbackContent);
                setNotice("Export copied.");
              } catch {
                setNotice(
                  "Clipboard unavailable. Select the export text above and copy it manually.",
                );
              }
            }}
          >
            <Copy /> Copy export text
          </Button>
        </div>
      )}
    </section>
  );
}
