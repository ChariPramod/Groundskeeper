"use client";

import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCheck,
  CircleAlert,
  Leaf,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { demoRepairDigest, getDemoRepair } from "@/lib/repair-review-types";

const steps = [
  "Code changes",
  "Docs are flagged",
  "The example is checked",
  "A fix is verified",
  "A human reviews",
];
const samplePage = getDemoRepair(demoRepairDigest)?.files[0];
if (!samplePage) throw new Error("Walkthrough sample is unavailable");
const page = samplePage;
function Code({ title, children }: { title: string; children: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-white p-5">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <pre className="overflow-x-auto rounded-lg bg-secondary p-4 text-sm leading-7">
        <code>{children}</code>
      </pre>
    </section>
  );
}
export function Walkthrough() {
  const [step, setStep] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  return (
    <main className="mx-auto max-w-6xl px-5 py-8 text-base leading-relaxed sm:px-10">
      <header className="mb-9 flex flex-wrap items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Leaf size={22} aria-hidden="true" /> Groundskeeper
        </Link>
        <Button variant="outline" asChild>
          <Link href="/">
            <ArrowLeft size={16} /> Open dashboard
          </Link>
        </Button>
      </header>
      <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-primary">
        Interactive product walkthrough
      </p>
      <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-5xl">
        The code changed. Did the instructions keep up?
      </h1>
      <p className="mt-5 max-w-3xl text-lg">
        Groundskeeper finds documentation that may be affected by code changes, tests supported
        examples, and prepares small fixes for people to review.
      </p>
      <div className="my-7 rounded-xl border border-border bg-secondary p-4 text-sm">
        <strong>Illustrative scenario.</strong> These steps use fixed sample data. Clicking through
        does not run code, access a repository, or create a pull request.
      </div>
      <nav aria-label="Walkthrough steps" className="mb-6 grid gap-2 sm:grid-cols-5">
        {steps.map((title, index) => (
          <button
            type="button"
            key={title}
            aria-current={step === index ? "step" : undefined}
            onClick={() => setStep(index)}
            className={`rounded-xl border p-4 text-left text-sm ${step === index ? "border-primary bg-primary text-white" : "border-border bg-white"}`}
          >
            <span className="mb-2 block opacity-75">0{index + 1}</span>
            {title}
          </button>
        ))}
      </nav>
      <section
        aria-label="Scenario controls"
        className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4"
      >
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={unavailable}
            onChange={(event) => setUnavailable(event.target.checked)}
            className="h-5 w-5 accent-primary"
          />{" "}
          Simulate unavailable runtime
        </label>
        <Button
          variant="ghost"
          onClick={() => {
            setStep(0);
            setUnavailable(false);
          }}
        >
          <RotateCcw size={16} /> Restart walkthrough
        </Button>
      </section>
      <section
        aria-live="polite"
        aria-atomic="true"
        className="min-h-80 rounded-2xl border border-border bg-white/60 p-5 sm:p-8"
      >
        <p className="text-sm text-primary">
          Step {step + 1} of {steps.length}
        </p>
        <h2 className="mb-4 mt-2 text-2xl font-semibold">{steps[step]}</h2>
        {step === 0 && (
          <>
            <p className="mb-5">
              A developer updates the greeting format. The function now returns punctuation that the
              tutorial does not show.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <Code title="Before · client.py">
                {'def greet(name):\n    return f"Hello {name}"'}
              </Code>
              <Code title="After · client.py">
                {'def greet(name):\n    return f"Hello, {name}!"'}
              </Code>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <p className="mb-5">
              The tutorial calls <code>greet</code>, so Groundskeeper marks it for checking. A
              connection to changed code is a reason to investigate, not proof that the
              documentation is wrong.
            </p>
            <Code title={page.path}>{page.before}</Code>
            <p className="mt-4 font-semibold">Finding: needs verification</p>
          </>
        )}
        {step === 2 &&
          (unavailable ? (
            <>
              <CircleAlert className="mb-3 text-destructive" aria-hidden="true" />
              <h3 className="text-xl font-semibold">Unknown, not passed</h3>
              <p className="mt-3">
                The isolated runtime is unavailable. Groundskeeper preserves the infrastructure
                error and cannot confirm whether the example is correct. It never runs repository
                code on the host as a fallback.
              </p>
            </>
          ) : (
            <>
              <p className="mb-5">
                The opted-in Python example is tested against the pinned source snapshot. In this
                sample, it exits successfully but contradicts the documented output.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <Code title="Expected output">{"Hello Ada"}</Code>
                <Code title="Observed output">{"Hello, Ada!"}</Code>
              </div>
              <p className="mt-4 font-semibold text-destructive">Sample result: assertion failed</p>
            </>
          ))}
        {step === 3 &&
          (unavailable ? (
            <>
              <h3 className="text-xl font-semibold">Repair blocked</h3>
              <p className="mt-3">
                Without a reproduced baseline failure and successful verification of the proposed
                version, the publisher cannot proceed. Restore the runtime and prepare again; the
                blocked artifact remains available for inspection.
              </p>
            </>
          ) : (
            <>
              <p className="mb-5">
                Only the expected output changes. The original mismatch must reproduce, and the
                proposed examples must pass independently before a repair is eligible for
                publication.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <Code title="Current documentation">{page.before}</Code>
                <Code title="Proposed documentation">{page.after}</Code>
              </div>
              <p className="mt-4 flex items-center gap-2 font-semibold text-primary">
                <CheckCheck size={20} /> Sample result: proposed example passed
              </p>
            </>
          ))}
        {step === 4 &&
          (unavailable ? (
            <>
              <h3 className="text-xl font-semibold">No draft PR is created</h3>
              <p className="mt-3">
                The missing runtime blocks publication. An infrastructure failure never becomes a
                successful verification.
              </p>
            </>
          ) : (
            <>
              <h3 className="text-xl font-semibold">A reviewable draft, with evidence</h3>
              <p className="mt-3">
                An operator inspects the exact patch and approves its proposal ID. The publishing
                command verifies it again, checks that the base commit has not moved, reserves the
                change budget, and creates a draft pull request on a separate branch.
              </p>
              <ul className="my-5 list-disc space-y-2 pl-5">
                <li>Default maximum: 3 pages, 150 changed lines, one PR per analysis.</li>
                <li>No direct default-branch edits or automatic merge.</li>
                <li>Retries reconcile the same proposal instead of creating competing repairs.</li>
              </ul>
              <p className="font-semibold">
                The maintainer decides whether to merge. This walkthrough creates no PR.
              </p>
            </>
          ))}
      </section>
      <div className="my-6 flex justify-between gap-3">
        <Button
          variant="outline"
          disabled={step === 0}
          onClick={() => setStep((value) => Math.max(0, value - 1))}
        >
          <ArrowLeft size={16} /> Previous step
        </Button>
        {step < 4 ? (
          <Button onClick={() => setStep((value) => Math.min(4, value + 1))}>
            Next step <ArrowRight size={16} />
          </Button>
        ) : (
          <Button asChild>
            <Link href="/">
              Explore the workspace <ArrowRight size={16} />
            </Link>
          </Button>
        )}
      </div>
      <section
        aria-label="Product readiness"
        className="mt-10 grid gap-5 border-t border-border pt-8 md:grid-cols-2"
      >
        <div>
          <h2 className="mb-3 text-xl font-semibold">What works today</h2>
          <p>
            Claim extraction, Python/TypeScript drift analysis, isolated Python verification,
            evidence recovery, review tools, and explicit repair publishing are implemented.
            Database and Docker integration tests have passed in CI.
          </p>
        </div>
        <div>
          <h2 className="mb-3 text-xl font-semibold">What still needs a pilot</h2>
          <p>
            The hosted dashboard uses sample data. A live GitHub App installation and worker
            deployment still need an end-to-end pilot. Shared team review history, hosted user
            accounts, and broader verification coverage remain future work.
          </p>
        </div>
      </section>
      <footer className="mt-8 flex flex-wrap gap-5 border-t border-border pt-6 text-sm">
        <a href="https://github.com/ChariPramod/Groundskeeper" className="underline">
          View source
        </a>
        <a
          href="https://github.com/ChariPramod/Groundskeeper/blob/main/docs/PRESENTING.md"
          className="flex items-center gap-2 underline"
        >
          <BookOpen size={16} /> Presenter guide
        </a>
      </footer>
    </main>
  );
}
