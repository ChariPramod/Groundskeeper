"use client";

import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Code2,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Layers3,
  Leaf,
  Menu,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sprout,
  Terminal,
  X,
} from "lucide-react";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NumberTicker } from "@/components/magicui/number-ticker";
import { RepairReview } from "@/components/repair-review";
import { RunReview } from "@/components/run-review";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchDashboard } from "@/lib/dashboard-client";
import type { DashboardData } from "@/lib/dashboard-types";
import { getDemoDashboard } from "@/lib/demo-data";

type Run = DashboardData["runs"][number];
type View = "Overview" | "Repositories" | "Activity" | "Work queue" | "Repairs";
const navigation = [
  { title: "Overview" as View, icon: Layers3 },
  { title: "Repositories" as View, icon: FolderGit2 },
  { title: "Activity" as View, icon: Activity },
  { title: "Work queue" as View, icon: ListIcon },
  { title: "Repairs" as View, icon: GitPullRequest },
];
function ListIcon({ size = 18 }: { size?: number }) {
  return <Terminal size={size} />;
}
const labels = {
  "needs-review": "Needs review",
  verified: "Verified",
  unknown: "Awaiting evidence",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  error: "Unavailable",
  pending: "Pending",
  processing: "Processing",
  retrying: "Retry scheduled",
};
function Status({ value }: { value: keyof typeof labels }) {
  return (
    <span className={`status status-${value}`}>
      <span />
      {labels[value]}
    </span>
  );
}
function date(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
}
function Counter({ value }: { value: number }) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && !reduced ? <NumberTicker value={value} /> : <span>{value}</span>;
}

function download(data: DashboardData) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `groundskeeper-${data.mode}-report.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Dashboard({
  initialData,
  liveConfigured,
}: {
  initialData: DashboardData | null;
  liveConfigured: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>("Overview");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [repository, setRepository] = useState("all");
  const [selected, setSelected] = useState<Run | null>(null);
  const [settings, setSettings] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  function openRun(run: Run) {
    returnFocus.current = document.activeElement as HTMLElement;
    setSelected(run);
  }
  function openSettings() {
    returnFocus.current = document.activeElement as HTMLElement;
    setSettings(true);
  }
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !target?.closest("input, textarea, [contenteditable=true]") &&
        searchRef.current
      ) {
        event.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  const runs = useMemo(
    () =>
      (data?.runs ?? []).filter(
        (run) =>
          (filter === "all" || run.status === filter) &&
          (repository === "all" || run.repository.fullName === repository) &&
          `${run.repository.fullName} ${run.id} ${run.afterCommit}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [data, filter, repository, query],
  );
  const allRuns = data?.runs ?? [];
  const review = allRuns.filter((run) => run.status === "needs-review");
  const verified = allRuns.filter((run) => run.status === "verified").length;
  const evidence = allRuns.flatMap((run) => run.evidence);
  const coverage = allRuns.length
    ? Math.round((allRuns.filter((run) => run.evidence.length).length / allRuns.length) * 100)
    : 0;
  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await fetchDashboard(token);
      setData(result);
      setSelected(null);
      setNotice("Workspace refreshed.");
      setSettings(false);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.name !== "TimeoutError" && failure.name !== "TypeError"
          ? failure.message
          : "The connection timed out or was interrupted. Try again when it’s available.",
      );
    } finally {
      setBusy(false);
      pending.current = false;
    }
  }
  function navigate(next: View) {
    setView(next);
    setMobile(false);
    setQuery("");
    setFilter("all");
    setRepository("all");
  }
  function showDemo() {
    setData(getDemoDashboard());
    setError("");
    setSettings(false);
    setNotice("Showing sample data. No live reports are included.");
  }
  return (
    <MotionConfig reducedMotion="user">
      <div className="workspace">
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {mobile && (
          <button
            type="button"
            aria-label="Close navigation"
            className="mobile-scrim"
            onClick={() => setMobile(false)}
          />
        )}
        <aside className={`sidebar ${mobile ? "is-open" : ""}`}>
          <a href="/" className="brand">
            <span className="brand-mark">
              <Sprout size={23} strokeWidth={1.8} />
            </span>
            groundskeeper<span className="brand-dot">.</span>
          </a>
          <button type="button" className="workspace-switch" onClick={openSettings}>
            <span className="workspace-avatar">G</span>
            <span>
              <strong>My workspace</strong>
              <small>
                {data?.mode === "live"
                  ? "Connected workspace"
                  : data
                    ? "Demo workspace"
                    : "Awaiting connection"}
              </small>
            </span>
            <ChevronDown size={15} />
          </button>
          <p className="nav-label">WORKSPACE</p>
          <nav aria-label="Main navigation">
            {navigation.map(({ title, icon: Icon }) => (
              <button
                type="button"
                key={title}
                onClick={() => navigate(title)}
                className={`nav-item ${view === title ? "active" : ""}`}
                aria-current={view === title ? "page" : undefined}
              >
                <Icon size={18} />
                <span>{title}</span>
                {title === "Work queue" && !!data?.queue.length && (
                  <span className="nav-count">{data.queue.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="garden-note">
              <span className="little-spark">
                <Sparkles size={16} />
              </span>
              <strong>A little care. A lot of clarity.</strong>
              <p>Keep your docs as thoughtful as the code behind them.</p>
              <button type="button" onClick={openSettings}>
                Connect your workspace <ArrowUpRight size={14} />
              </button>
            </div>
            <button type="button" className="nav-item" onClick={openSettings}>
              <Settings2 size={18} />
              Connection settings
            </button>
            <div className="profile">
              <span className="profile-avatar">GK</span>
              <div>
                <strong>Local workspace</strong>
                <small>Documentation caretaker</small>
              </div>
              <Leaf size={17} />
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumbs">
              <button
                type="button"
                className="icon-button mobile-toggle"
                aria-label="Open navigation"
                onClick={() => setMobile(true)}
              >
                <Menu size={19} />
              </button>
              <span>Workspace</span>
              <ChevronRight size={13} />
              <strong>{view}</strong>
            </div>
            <div className="topbar-right">
              <span className="environment">
                <span />
                {data?.mode === "live" ? "Live data" : data ? "Demo mode" : "Not connected"}
              </span>
              <span className="topbar-divider" />
              <button
                type="button"
                className="icon-button"
                aria-label="Connection settings"
                onClick={openSettings}
              >
                <Settings2 size={18} />
              </button>
              <span className="tiny-avatar">G</span>
            </div>
          </header>
          <motion.main
            id="main-content"
            tabIndex={-1}
            className="main-content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  <span /> YOUR DOCUMENTATION, TENDED.
                </div>
                <h1>
                  {view === "Overview"
                    ? "A healthier home for your docs."
                    : view === "Repositories"
                      ? "Every repository. In view."
                      : view === "Work queue"
                        ? "Good work, in motion."
                        : view === "Repairs"
                          ? "Small changes. Carefully verified."
                          : "A record of every check."}
                </h1>
                <p>
                  {view === "Overview"
                    ? "Catch the drift. Check the details. Keep your team moving."
                    : view === "Repositories"
                      ? "Follow the code and the documentation that grows around it."
                      : view === "Work queue"
                        ? "Follow deliveries from their first attempt to their final outcome."
                        : view === "Repairs"
                          ? "Inspect the exact patch and its evidence before approving a draft pull request."
                          : "Explore analysis runs and the evidence behind each result."}
                </p>
              </div>
              <div className="heading-actions">
                <Button variant="outline" onClick={() => data && download(data)} disabled={!data}>
                  <ArrowDownToLine size={15} /> Export report
                </Button>
                <Button onClick={refresh} disabled={busy}>
                  <RefreshCw size={15} className={busy ? "spin" : ""} />
                  {busy ? "Refreshing…" : "Refresh workspace"}
                </Button>
              </div>
            </div>
            {error && (
              <div className="alert" role="alert" aria-label="Workspace connection error">
                <CircleAlert size={18} />
                <div>
                  <strong>We couldn’t refresh your workspace.</strong>
                  <p>
                    {error}{" "}
                    {data
                      ? "Your last loaded view is still shown."
                      : "Connect below or explore the demo."}
                  </p>
                </div>
                <Button variant="outline" onClick={refresh} disabled={busy}>
                  Try again
                </Button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setError("")}
                  aria-label="Dismiss error"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <p role="status" className="sr-only">
              {notice}
            </p>
            {view === "Repairs" ? (
              <RepairReview mode={data?.mode ?? (liveConfigured ? "live" : "demo")} token={token} />
            ) : !data ? (
              <section className="empty-connect">
                <span className="empty-icon">
                  <Plug size={30} />
                </span>
                <h2>Your workspace is ready to connect.</h2>
                <p>
                  Use your access token to load live reports, or take a look around with sample
                  data.
                </p>
                <Button onClick={openSettings}>
                  Connect workspace <ArrowRight size={16} />
                </Button>
                <Button variant="ghost" onClick={showDemo}>
                  Explore demo
                </Button>
              </section>
            ) : (
              <>
                {data.mode === "demo" && (
                  <div className="demo-note">
                    <span>
                      <Sparkles size={14} /> You’re exploring a sample workspace. All reports and
                      activity below are illustrative.
                    </span>
                    <button type="button" onClick={openSettings}>
                      Connect live data <ArrowRight size={13} />
                    </button>
                  </div>
                )}
                {view === "Overview" && (
                  <>
                    <div className="metrics-grid">
                      {[
                        {
                          label: "Repositories in view",
                          value: data.repositories.length,
                          icon: FolderGit2,
                          foot: "Across your workspace",
                          tone: "",
                        },
                        {
                          label: "Runs needing review",
                          value: review.length,
                          icon: CircleAlert,
                          foot: "A little attention goes a long way",
                          tone: "amber",
                        },
                        {
                          label: "Verified runs",
                          value: verified,
                          icon: ShieldCheck,
                          foot: "Backed by execution evidence",
                          tone: "green",
                        },
                        {
                          label: "Runs with evidence",
                          value: coverage,
                          icon: FileCode2,
                          foot: `${evidence.length} evidence records in this view`,
                          tone: "",
                          suffix: "%",
                        },
                      ].map((metric) => (
                        <section className="metric-card" key={metric.label}>
                          <div className="metric-label">
                            {metric.label}
                            <metric.icon size={17} />
                          </div>
                          <div className={`metric-value ${metric.tone}`}>
                            <Counter value={metric.value} />
                            {metric.suffix}
                          </div>
                          <p>
                            {metric.tone === "green" && <CheckCheck size={13} />}
                            {metric.foot}
                          </p>
                        </section>
                      ))}
                    </div>
                    <div className="overview-grid">
                      <section className="health-card">
                        <div className="section-heading">
                          <div>
                            <span className="eyebrow light">THE BIG PICTURE</span>
                            <h2>Clarity starts with evidence.</h2>
                          </div>
                          <span className="health-icon">
                            <Leaf size={22} />
                          </span>
                        </div>
                        <p>
                          Every checked example brings your documentation
                          <br className="desktop-break" /> one step closer to the code.
                        </p>
                        <div className="health-bottom">
                          <div className="health-score">
                            {coverage}
                            <span>%</span>
                            <small>of recent runs have evidence</small>
                          </div>
                          <div className="growth-illustration" aria-hidden="true">
                            <div className="orbit orbit-one" />
                            <div className="orbit orbit-two" />
                            <div className="plant-stem" />
                            <span className="plant-leaf leaf-one" />
                            <span className="plant-leaf leaf-two" />
                            <span className="plant-leaf leaf-three" />
                            <span className="plant-leaf leaf-four" />
                            <span className="plant-seed" />
                          </div>
                        </div>
                        <div className="health-track">
                          <span style={{ width: `${coverage}%` }} />
                        </div>
                        <div className="health-caption">
                          <span>
                            <span className="legend-dot" /> With evidence
                          </span>
                          <span>
                            {allRuns.filter((r) => r.evidence.length).length} of {allRuns.length}{" "}
                            runs
                          </span>
                        </div>
                      </section>
                      <section className="attention-card">
                        <div className="section-heading">
                          <h2>A little attention needed</h2>
                          <span className="soft-count">{review.length} runs</span>
                        </div>
                        <p className="section-subtitle">
                          Start with the places where code and docs may disagree.
                        </p>
                        <div className="attention-list">
                          {review.slice(0, 3).map((run, i) => (
                            <button
                              type="button"
                              key={run.id}
                              className="attention-row"
                              onClick={() => openRun(run)}
                            >
                              <span className={`attention-icon tone-${i}`}>
                                <FileCode2 size={18} />
                              </span>
                              <span>
                                <strong>{run.repository.name}</strong>
                                <small>
                                  {run.affectedClaims} affected claims ·{" "}
                                  {run.evidence.some((e) => e.status === "failed")
                                    ? "Example needs review"
                                    : "Verification needed"}
                                </small>
                              </span>
                              <ArrowUpRight size={16} />
                            </button>
                          ))}
                          {!review.length && (
                            <div className="quiet-state">
                              <CircleCheck size={24} />
                              <p>No review flags in this view.</p>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="text-link attention-link"
                          onClick={() => {
                            navigate("Activity");
                            setFilter("needs-review");
                          }}
                        >
                          View review queue <ArrowRight size={14} />
                        </button>
                      </section>
                    </div>
                  </>
                )}
                {view === "Repositories" ? (
                  <section className="repository-grid">
                    {data.repositories.map((repo) => {
                      const recent = allRuns.filter((r) => r.repository.fullName === repo.fullName);
                      const needsReview = recent.filter((r) => r.status === "needs-review").length;
                      return (
                        <button
                          type="button"
                          key={repo.id}
                          className="repository-card"
                          onClick={() => {
                            navigate("Activity");
                            setRepository(repo.fullName);
                          }}
                        >
                          <span className="repo-card-icon">
                            <FolderGit2 size={22} />
                          </span>
                          <ArrowUpRight className="repo-arrow" size={17} />
                          <h2>{repo.name}</h2>
                          <p>{repo.fullName}</p>
                          <div className="repo-branch">
                            <GitBranch size={13} />
                            {repo.defaultBranch}
                          </div>
                          <div className="repo-card-footer">
                            <span>{recent.length} recent runs</span>
                            <span className={needsReview ? "amber" : "green"}>
                              {needsReview ? `${needsReview} need review` : "No review flags"}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                    {!data.repositories.length && (
                      <Empty
                        title="No repositories yet"
                        detail="Installed repositories appear after their first persisted analysis."
                      />
                    )}
                  </section>
                ) : view === "Work queue" ? (
                  <section className="panel">
                    <div className="panel-title">
                      <h2>Delivery queue</h2>
                      <span className="soft-count">{data.queue.length} unprocessed</span>
                    </div>
                    <div className="queue-intro">
                      <ShieldCheck size={17} />
                      Ten-minute leases · Five attempts · Explicit recovery after terminal failure
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Delivery</th>
                            <th>Status</th>
                            <th>Attempts</th>
                            <th>Next attempt</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.queue.map((item) => (
                            <tr key={item.id}>
                              <td>
                                <strong>{item.repository}</strong>
                                <small className="mono">{item.id}</small>
                              </td>
                              <td>
                                <Status value={item.status} />
                              </td>
                              <td>
                                <span className="attempts">
                                  {item.attempts} <span>/ 5</span>
                                </span>
                              </td>
                              <td>{item.nextAttemptAt ? date(item.nextAttemptAt) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!data.queue.length && (
                      <Empty
                        title="All caught up"
                        detail="No unprocessed deliveries in this workspace."
                      />
                    )}
                    <div className="panel-footer">
                      <Terminal size={14} />
                      Terminal deliveries can be inspected and retried with the local queue command.
                    </div>
                  </section>
                ) : (
                  <section className="panel">
                    <div className="panel-title">
                      <div>
                        <h2>{view === "Overview" ? "Recent activity" : "Analysis runs"}</h2>
                        <p>Changes worth knowing about, with the context to act.</p>
                      </div>
                      <span className="soft-count">{runs.length} runs</span>
                    </div>
                    <div className="table-toolbar">
                      <fieldset className="filter-tabs" aria-label="Filter runs">
                        {[
                          { value: "all", label: "All runs" },
                          { value: "needs-review", label: "Needs review" },
                          { value: "verified", label: "Verified" },
                        ].map((tab) => (
                          <button
                            type="button"
                            key={tab.value}
                            className={filter === tab.value ? "selected" : ""}
                            aria-pressed={filter === tab.value}
                            onClick={() => setFilter(tab.value)}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </fieldset>
                      <div className="table-search">
                        <Search size={15} />
                        <input
                          ref={searchRef}
                          aria-label="Search runs"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Search repositories or runs…"
                        />
                        <span>/</span>
                      </div>
                    </div>
                    {repository !== "all" && (
                      <div className="active-filter">
                        Repository: {repository}
                        <button
                          type="button"
                          onClick={() => setRepository("all")}
                          aria-label="Clear repository filter"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    )}
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Repository / run</th>
                            <th>Status</th>
                            <th>Impact</th>
                            <th>
                              Last analyzed <ChevronDown size={12} />
                            </th>
                            <th>
                              <span className="sr-only">Details</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {runs.slice(0, view === "Overview" ? 5 : 50).map((run) => (
                            <tr key={run.id}>
                              <td>
                                <button
                                  type="button"
                                  className="run-title"
                                  onClick={() => openRun(run)}
                                >
                                  <span className="repo-icon">
                                    <BookOpen size={17} />
                                  </span>
                                  <span>
                                    <strong>{run.repository.name}</strong>
                                    <small>
                                      <GitCommitHorizontal size={12} />
                                      {run.afterCommit.slice(0, 7)}
                                      <span className="run-id">{run.id.slice(0, 16)}</span>
                                    </small>
                                  </span>
                                </button>
                              </td>
                              <td>
                                <Status value={run.status} />
                              </td>
                              <td>
                                <span className={run.affectedClaims ? "impact" : "muted"}>
                                  {run.affectedClaims} affected
                                </span>
                                <small>{run.totalClaims} claims indexed</small>
                              </td>
                              <td className="date-cell">
                                {date(run.createdAt)}
                                <small>UTC</small>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={`View ${run.repository.name} run ${run.id}`}
                                  onClick={() => openRun(run)}
                                >
                                  <ArrowUpRight size={17} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!runs.length && (
                      <Empty
                        title="Nothing matches just yet"
                        detail="Try another repository name or clear your filters."
                        action={() => {
                          setQuery("");
                          setFilter("all");
                          setRepository("all");
                        }}
                      />
                    )}
                    <div className="panel-footer">
                      <span>
                        <span className="legend-dot" />
                        {data.mode === "demo" ? "Sample activity" : "Latest saved reports"} ·{" "}
                        {allRuns.length} runs in this view
                      </span>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() =>
                          view === "Overview" ? navigate("Activity") : searchRef.current?.focus()
                        }
                      >
                        {view === "Overview" ? "View all activity" : "Search activity"}
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </section>
                )}
                <footer className="page-footer">
                  <span>
                    <Sprout size={15} />A little upkeep. Lasting trust.
                  </span>
                  <span>
                    {data.mode === "demo" ? "Sample snapshot" : "Loaded snapshot"} ·{" "}
                    {date(data.generatedAt)} UTC
                  </span>
                </footer>
              </>
            )}
          </motion.main>
        </div>
        <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent
            className="evidence-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              returnFocus.current?.focus();
            }}
          >
            <DialogHeader>
              <span className="dialog-eyebrow">
                <FileCode2 size={16} /> ANALYSIS DETAILS
              </span>
              <DialogTitle>{selected?.repository.name}</DialogTitle>
              <DialogDescription>
                Commit-matched findings and execution evidence. A drift candidate alone does not
                prove the docs are stale.
              </DialogDescription>
            </DialogHeader>
            {selected && (
              <div>
                <div className="detail-meta">
                  <Status value={selected.status} />
                  <span>
                    <GitCommitHorizontal size={14} />
                    {selected.beforeCommit.slice(0, 7)} → {selected.afterCommit.slice(0, 7)}
                  </span>
                </div>
                <div className="detail-stats">
                  <div>
                    <strong>{selected.affectedClaims}</strong>
                    <small>Affected claims</small>
                  </div>
                  <div>
                    <strong>{selected.totalClaims}</strong>
                    <small>Indexed claims</small>
                  </div>
                  <div>
                    <strong>{selected.evidence.length}</strong>
                    <small>Evidence records</small>
                  </div>
                </div>
                <RunReview
                  key={`${data?.mode}:${selected.id}`}
                  runId={selected.id}
                  token={token}
                  mode={data?.mode ?? "demo"}
                />
                <h3 className="detail-title">Execution evidence</h3>
                {selected.evidence.length ? (
                  <div className="evidence-list">
                    {selected.evidence.map((item) => (
                      <div className="evidence-item" key={item.id}>
                        <div>
                          <Code2 size={16} />
                          <strong>{item.label}</strong>
                          <Status value={item.status} />
                        </div>
                        <p>{item.detail}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title="Evidence hasn’t been collected"
                    detail="Run the stored-analysis verifier to check affected examples. Until then, this result remains a candidate for review."
                  />
                )}
                <div className="detail-run-id">
                  <span>Run ID</span>
                  <code>{selected.id}</code>
                </div>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(selected.id);
                      setNotice("Run ID copied.");
                    } catch {
                      setNotice("Copy unavailable. Select the run ID above to copy it manually.");
                    }
                  }}
                >
                  <GitCommitHorizontal size={15} />
                  Copy run ID
                </Button>
                <p className="detail-note">{notice}</p>
              </div>
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={settings} onOpenChange={setSettings}>
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              returnFocus.current?.focus();
            }}
          >
            <DialogHeader>
              <span className="dialog-eyebrow">
                <Plug size={16} /> CONNECTION
              </span>
              <DialogTitle>Make this workspace yours.</DialogTitle>
              <DialogDescription>
                Explore the demo freely, or connect to saved reports from your local Groundskeeper
                installation.
              </DialogDescription>
            </DialogHeader>
            <div className="connection-status">
              <span className="legend-dot" />
              {liveConfigured ? "Server requests live data" : "Server running in demo mode"}
            </div>
            {liveConfigured ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void refresh();
                }}
              >
                <label className="field-label" htmlFor="access-token">
                  Dashboard access token
                </label>
                <input
                  id="access-token"
                  className="text-input"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Enter your access token"
                />
                <p className="field-help">
                  Kept in memory for this tab. It is never saved in browser storage.
                </p>
                <Button type="submit" disabled={busy || !token.trim()}>
                  <Plug size={15} />
                  {busy ? "Connecting…" : "Connect live data"}
                </Button>
              </form>
            ) : (
              <div className="setup-steps">
                <p>
                  <strong>1.</strong> Configure the database and run migrations.
                </p>
                <p>
                  <strong>2.</strong> Set the dashboard environment variables in{" "}
                  <code>apps/web/.env.local</code>.
                </p>
                <pre>
                  DASHBOARD_MODE=live{"\n"}DASHBOARD_INSTALLATION_ID=…{"\n"}DASHBOARD_ACCESS_TOKEN=…
                  {"\n"}DATABASE_URL=…
                </pre>
                <p>
                  <strong>3.</strong> Restart the web server, then enter your token here.
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="connection-error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <Button variant="outline" onClick={showDemo}>
                <Sparkles size={15} />
                Explore demo
              </Button>
              <span>Read-only by design</span>
              <ShieldCheck size={15} />
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </MotionConfig>
  );
}
function Empty({ title, detail, action }: { title: string; detail: string; action?: () => void }) {
  return (
    <div className="empty-state">
      <Search size={23} />
      <h3>{title}</h3>
      <p>{detail}</p>
      {action && (
        <Button variant="outline" onClick={action}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
