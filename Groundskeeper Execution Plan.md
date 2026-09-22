# Groundskeeper: Implementation and Execution Plan

Working name: Groundskeeper (rename later). An always-on maintenance agent for a team's whole knowledge surface: docs, runbooks, tutorials, screenshots, diagrams, and wiki pages. It finds what is stale, proves it by executing the docs, fixes it through reviewable PRs, learns the team's conventions from reviewer edits, and serves the maintained knowledge back to humans and agents over MCP.

Status: pre-build. Author: Pramod. Last revised: Sept 10, 2026.

---

## 0. One-paragraph definition

Groundskeeper installs as a GitHub App and connects to wherever knowledge lives (docs repo, Confluence, Notion, a headless CMS, Slack, the support desk). It builds a claim index: every sentence in the docs that asserts something about the system (a command, a parameter, a default, a URL, a screenshot, a step) linked to the code symbols, config keys, and UI routes it depends on. When code merges, it maps the diff to affected claims. On a nightly cadence, a Planner reads the evidence bundle (drift, failed verifications, unanswered questions from support and agent queries), a Developer rewrites the affected pages, and an independent QA agent verifies the result by actually running it: tutorials execute in a sandbox, CLI help is diffed, API examples are replayed, screenshots are regenerated and compared. Only verified changes become PRs, inside a bounded change budget per run. Reviewer edits feed a conventions wiki that tunes how the Developer writes next time.

Scope fence for the first six months: docs-as-code repos (Markdown/MDX) plus one wiki target and one CMS target; Python and TypeScript codebases; GitHub only. No Confluence before v2, no GitLab before v3.

---

## 1. Why this, why now

- Documentation drift is a solved problem for API references and an unsolved problem for everything else. Mintlify Workflows and GitBook now regenerate reference pages from OpenAPI specs and open PRs when user-facing code changes; GitHub's Continuous AI pattern lists "continuous documentation" as a standard agentic workflow. What none of them do: verify that a tutorial still runs, notice that a screenshot shows a UI that no longer exists, maintain runbooks and internal wikis that live outside the docs repo, or learn from what people actually asked and could not find.
- AI coding agents raised merge frequency without raising doc-review capacity, so drift compounds faster. The same agents now read docs over MCP, which means stale docs mislead machines as well as people. A team's docs are now an input to its automation.
- The papers from the week of Aug 31 to Sept 6, 2026 give the architecture: Harness-of-Harness for a multi-day Planner/Developer/QA loop with independent testing, WikiSkill for conventions learned from runs, SKILL.state for keeping a long-running maintenance loop bounded, and CORAL's bounded change budget for making an autonomous loop safe to run against something real.

## 2. Landscape and the wedge

| Existing | What it does | What it does not do |
|---|---|---|
| Mintlify Workflows | Push-triggered drafts of doc PRs for user-facing code changes, source-cited | One PR per push; no execution-based verification; docs-repo only; no learning from reviewer edits |
| GitBook | Regenerates API reference from OpenAPI; MCP server for reading and editing docs; MCP query analytics | Reference pages only; no tutorials, runbooks, screenshots, or wiki maintenance |
| Tembo, Augment Code guides, GitHub Agentic Workflows | Merge-triggered doc-drift agents opening PRs | Pattern, not product; text-only; no independent QA; no prioritization from demand signals |
| Swimm and similar | Docs coupled to code with drift warnings | Manual coupling; no autonomous repair |
| Link checkers, doctest, screenshot tools | Point solutions | Not connected to a maintenance loop |

The wedge, in priority order:

1. **Verification by execution.** Every proposed change is tested the way a reader would use it: run the tutorial, run the command, replay the request, render the page and take the screenshot. "Docs that pass tests" is a category nobody owns.
2. **Whole knowledge surface.** Docs repo plus wiki plus CMS plus runbooks plus the screenshots and diagrams inside them (the DAM problem). Drift lives everywhere; tools today only look in the repo.
3. **Demand-driven prioritization.** Support tickets, Slack questions, docs-search zero-result queries, and MCP agent queries that returned nothing tell you which gaps matter. Fix what people are asking about.
4. **Multi-day autonomous loop with independent QA and a change budget.** Not a PR per push; a planned maintenance program that keeps working and cannot flood a team with PRs.
5. **Conventions that learn.** Reviewer edits become a conventions wiki that changes how the next rewrite is written. The team's style is captured without a style guide.

## 3. Versions and what "shipped" means

### v1 (weeks 1 to 8): the claim index and verified drift PRs
Shipped means: a GitHub App a team installs on a docs repo and a code repo; a claim index built on install; merge-triggered drift detection that maps diffs to claims; verification of affected claims by execution (code blocks, CLI, links); a PR per verified fix with the evidence attached; a docs-health report. Free for public repos.

### v2 (weeks 9 to 18): the maintenance loop, screenshots, wiki and CMS targets
Shipped means: nightly Planner/Developer/QA loop with SKILL.state and a change budget; screenshot regeneration and visual diff with a DAM for visual assets; Confluence or Notion as a maintained target; a headless CMS adapter; demand signals from support and Slack; a TypeScript dashboard; an MCP server that serves the maintained docs with freshness metadata; paid tier for private repos.

### v3 (weeks 19 to 30): learning, scale, and proof
Shipped means: the conventions wiki with gated skill updates and rollback; historical-replay eval on public repos (walk six months of commits and measure whether docs stay true); fine-tuned claim linker and staleness classifier; cloud batch for large repos; Databricks health analytics; GitLab support; ten paying teams or three well-known OSS projects using it.

Do not build screenshots in v1. The claim index and execution-based verification are the foundation; everything else sits on them.

---

## 4. System architecture

```
 Sources                              Groundskeeper                              Targets
 ┌──────────────┐   webhooks   ┌───────────────────────────────────────┐   PRs   ┌──────────────┐
 │ Code repos   ├─────────────►│ GitHub App (TypeScript, Probot)        ├────────►│ Docs repo    │
 │ Docs repos   │              │ webhooks, PR creation, checks API      │         │ (MD/MDX)     │
 │ OpenAPI      │              └───────────────┬───────────────────────┘         └──────────────┘
 └──────────────┘                              │                                  ┌──────────────┐
 ┌──────────────┐   MCP        ┌───────────────▼───────────────────────┐  MCP/API │ Confluence / │
 │ Confluence   ├─────────────►│ Product API (NestJS, TS)               ├────────►│ Notion       │
 │ Notion       │              │ orgs, repos, claims, PRs, budgets,     │         └──────────────┘
 │ Slack        │              │ health scores, billing                 │  API    ┌──────────────┐
 │ Support desk │              └───────────────┬───────────────────────┘────────►│ Headless CMS │
 │ Docs search  │                              │                                  │ Payload etc. │
 │ MCP queries  │              ┌───────────────▼───────────────────────┐         └──────────────┘
 └──────────────┘              │ ML Service (Python, FastAPI)           │
                               │  claim extraction and linking          │         ┌──────────────┐
                               │  drift mapper (diff → claims)          │  serve  │ Docs MCP     │
                               │  LangGraph maintenance loop:           ├────────►│ server (RAG, │
                               │   Planner → Developer → QA             │         │ freshness)   │
                               │  conventions wiki (WikiSkill)          │         └──────────────┘
                               └───┬─────────────┬─────────────┬───────┘
                                   │             │             │
                       ┌───────────▼──┐  ┌───────▼──────┐  ┌───▼───────────────────────┐
                       │ Postgres +   │  │ Temporal      │  │ Verification sandboxes     │
                       │ pgvector:    │  │ nightly loop, │  │ Docker/E2B for tutorials,  │
                       │ claim index, │  │ PR lifecycle, │  │ Playwright for screenshots,│
                       │ symbols,     │  │ verification  │  │ HTTP replay for API docs   │
                       │ state, wiki  │  │ jobs          │  └────────────────────────────┘
                       └──────────────┘  └───────────────┘
                                                            ┌────────────────────────────┐
                                                            │ Visual DAM: GCS, versioned  │
                                                            │ screenshots and diagrams    │
                                                            │ with provenance (commit,    │
                                                            │ route, viewport, hash)      │
                                                            └────────────────────────────┘
   Offline: fine-tunes on Vertex AI or SageMaker (claim linker, staleness classifier),
            historical-replay evals, Databricks doc-health analytics, vLLM for VLM judge
```

Same two-service split as the other plans: TypeScript owns the GitHub App, product API, dashboard, MCP servers, and CMS adapters; Python owns anything that touches a model or a sandbox.

---

## 5. Data model and sources

### 5.1 The claim index (the core data structure)
Every doc page is parsed (remark/unified for Markdown and MDX; Confluence storage format and Notion blocks normalized to the same AST). Each paragraph, code block, admonition, table row, image, and step is split into claims. A claim has:
- text, page, anchor, position, last verified, verification method, status (verified, stale, unverifiable, unknown)
- references: code symbols (from tree-sitter: functions, classes, CLI commands, flags, config keys, env vars), API routes and parameters (from OpenAPI), UI routes and selectors (for screenshots), URLs, version strings, file paths
- evidence: the last verification result and artifact (stdout, diff, screenshot pair)
- demand: count of related support tickets, Slack questions, zero-result searches, and MCP queries in the last 30 days

The linker maps claim text to references. v1 uses tree-sitter exact-match plus an LLM pass for fuzzy links; v3 fine-tunes a bi-encoder (see 6.2).

### 5.2 Sources
- Code: GitHub App with contents and pull-request permissions; clone on install; tree-sitter for Python and TypeScript symbol extraction; OpenAPI specs where present.
- Docs-as-code: Markdown and MDX in any repo (Docusaurus, Mintlify, Nextra, Starlight, plain READMEs).
- Wiki (v2): Confluence Cloud and Notion via their APIs, or via their MCP servers where available; pages become claims like any other.
- CMS (v2): headless CMS adapters (Payload first, then Contentful and Sanity) for teams whose product docs or help center live in a CMS.
- Demand signals (v2): Zendesk or Intercom tickets, Slack channels the team chooses, docs-site search logs, and the Groundskeeper docs MCP server's own query log. Only metadata and question text; never customer PII beyond what the team already stores.

### 5.3 Eval corpora you can build now
- Synthetic drift: take a public repo with good docs (pick five with permissive licenses and active tutorials), apply scripted mutations (rename a flag, change a default, remove a parameter, move a file, change a CLI's output), and record which claims should flip. This gives drift-detection precision and recall from day one.
- Historical replay (v3): walk a repo's real commit history over six months; at each docs-changing commit, check whether Groundskeeper would have proposed the change the humans actually made. Measures usefulness against ground truth nobody had to label.
- Reviewer-edit pairs: once real PRs exist, the diff between what the Developer proposed and what the reviewer merged is a labeled convention example.

---

## 6. Component design and tool choices

### 6.1 GitHub App and product API (TypeScript)
- Probot-based GitHub App: installation, push and pull_request webhooks, Checks API for a "docs health" check on PRs, PR creation with evidence in the description and a per-claim comment thread.
- NestJS product API with Prisma on Postgres; tRPC for the dashboard; versioned REST for integrations. Auth through GitHub OAuth; org-level workspaces.
- Change budget enforcement lives here: max pages, max PRs, and max lines changed per run, configurable per repo, defaulting low. Groundskeeper never commits directly to a default branch. This is the CORAL guardrail made concrete.

### 6.2 Claim extraction, linking, and staleness (Hugging Face, PyTorch)
- Parsing: remark and rehype plugins for Markdown/MDX; Confluence and Notion normalizers.
- Symbol extraction: tree-sitter grammars for Python and TypeScript; a CLI introspection step that runs `--help` for documented commands inside the sandbox and records the output as a symbol source.
- Linking v1: exact and normalized matching of identifiers, paths, flags, and routes, then an LLM pass (small open model on vLLM) to link fuzzy claims ("the retry setting", "the settings page") to candidates, with confidence.
- Linking v3: fine-tune a bi-encoder (a code-aware embedding model such as UniXcoder-class or a modern code embedding model) on (claim, symbol) pairs mined from repos where docs link explicitly, plus reviewer-confirmed links. Trained with PyTorch and sentence-transformers on a Vertex AI custom training job or SageMaker, tracked in MLflow.
- Staleness classifier v3: given (claim, diff hunk), predict whether the claim is affected. Start with SetFit on a few hundred labels from synthetic drift; full fine-tune of a DeBERTa-v3 or ModernBERT once labels exceed a thousand. This model is what keeps the drift mapper from flagging everything on every merge.

### 6.3 Drift mapper
- On merge: diff → changed symbols (tree-sitter diff), changed OpenAPI operations, changed UI routes (from the app's router or a sitemap) → affected claims via the link graph → verification jobs queued for those claims only.
- On schedule: a full-surface audit that re-verifies claims by age and demand, oldest and most-asked first, within the run budget.

### 6.4 Verification (the QA Tester)
Verification methods, chosen per claim type:
- **Code blocks and tutorials**: extract runnable blocks in order, run them in a fresh sandbox (Docker locally; E2B or Modal in the cloud for isolation and speed) against the repo at HEAD, compare stdout and exit codes with documented expected output. Blocks marked non-runnable are skipped and flagged as unverifiable.
- **CLI claims**: run `--help` and version commands; diff flags and descriptions against the doc.
- **API examples**: replay documented requests against a staging base URL the team supplies, or validate against the OpenAPI spec when no environment is available; compare response shapes.
- **Config and defaults**: read the actual default from code (tree-sitter plus a small LLM read) and compare.
- **Links and anchors**: HTTP checks with caching; internal anchor resolution.
- **Screenshots (v2)**: Playwright renders the documented route at the documented viewport, captures, compares against the stored asset with SSIM and a perceptual hash; borderline diffs go to a VLM judge (Qwen-VL class on vLLM) with the question "does the documented step still match this UI." Regenerated screenshots are proposed as part of the PR.
- **Diagrams (v2)**: Mermaid and other diagrams-as-code are regenerated from extracted architecture facts (services, routes, dependencies) and diffed; raster diagrams are flagged with the facts that changed and left to a human.

The QA agent is independent of the Developer by construction: it never sees the Developer's reasoning, only the proposed page, and it runs its own verification, not the checks the Developer used while writing. That is the Harness-of-Harness separation and it is what stops the loop from grading its own homework.

### 6.5 The maintenance loop (LangGraph, SKILL.state, tool calling)
A LangGraph graph with the Postgres checkpointer, run nightly by Temporal:

```
load_state -> collect_evidence (drift, failed verifications, demand signals, open PR status)
   -> plan (Planner: rank and scope work inside the change budget)
   -> for each work item: draft (Developer) -> verify (QA) -> open_pr | discard
   -> update_state -> write_evidence_bundle
```

- State is an explicit JSON document (backlog with priorities, in-flight PRs, verification results, budget used, last audit timestamps) with a schema; each node emits a JSON patch; reasoning is discarded once the patch validates. The loop runs for months without the prompt growing. This is SKILL.state used exactly as intended.
- Tools (typed, schema'd): `get_claims_for_symbols`, `get_page`, `propose_page_edit`, `run_verification`, `get_demand_signals`, `open_pr`, `read_conventions`, `record_reviewer_edit`.
- Models: Claude (Sonnet class) for planning and rewriting where quality matters; an open model on vLLM for linking, classification, and the VLM judge where volume matters. Model router with a per-node config flag.

### 6.6 Conventions wiki (WikiSkill)
Three layers with different write rules:
- Immutable traces: every Developer proposal, every QA result, every reviewer edit, written once.
- Wiki: structured patterns extracted from traces by a maintainer agent ("this team writes imperative step headings", "code blocks always include the expected output", "never link to the internal wiki from public docs") with an evolution log.
- Skills: the Developer's style and structure instructions per repo, updated by a proposer agent from the wiki, gated on an eval (does the new skill produce rewrites closer to reviewer-merged versions on a held-out set of edit pairs), and rolled back on regression.

### 6.7 Visual DAM (screenshots, diagrams, videos)
- GCS bucket per org, versioned; asset metadata in Postgres: type, source route, viewport, commit hash, capture time, perceptual hash, which claims reference it, current verification status.
- The DAM is what makes screenshot maintenance possible: you cannot detect a stale image without knowing which route and commit produced it. Every regenerated screenshot carries full provenance in the PR.
- Video (v3): frame sampling plus the same VLM judgment to flag walkthrough videos that no longer match the UI; regeneration is out of scope, flagging is not.

### 6.8 Docs MCP server and RAG (serve what you maintain)
- A TypeScript MCP server exposing `search_docs`, `get_page`, `get_claim_evidence`, and `report_gap`. Retrieval is hybrid (BM25 plus embeddings in pgvector, reranked) with freshness metadata on every result: last verified, verification method, status. An agent that reads "verified yesterday by execution" trusts the answer differently from "unverified since March."
- Every query that returns nothing or low confidence is logged as a demand signal for the Planner. Serving and maintaining close the loop.

### 6.9 CMS adapters
- Payload first (self-hosted, TypeScript, Postgres): read pages into the claim index, write proposed edits as drafts for review, never publish directly. Then Contentful and Sanity through their management APIs with the same draft-only rule.
- Groundskeeper's own docs and the health-report content model can live in Payload too, which is a legitimate dogfood, not padding.

### 6.10 Workflow automation (Temporal)
- Nightly maintenance loop per repo with retries, cancellation, and a hard wall-clock cap.
- Verification jobs as child workflows with sandbox provisioning and teardown; screenshot jobs with browser pools.
- PR lifecycle: watch for merges and closes, record reviewer edits, expire stale PRs after a configurable window.
- Scheduled full-surface audits and index rebuilds.

### 6.11 Cloud (GCP primary, deliberate use of the others)
GCP is primary here: Cloud Run for both services and the MCP server, Cloud SQL Postgres with pgvector, GCS for the DAM, Cloud Build or GitHub Actions for deploys, Secret Manager, Cloud Logging and Trace. Vertex AI for embeddings and Vector Search as the alternate retrieval backend, and Vertex AI custom training jobs for the linker and staleness fine-tunes with Vertex Experiments.
- Sandboxes: E2B or Modal for isolated execution (fast cold starts, per-run isolation, no shared kernel with your services); Docker locally.
- **SageMaker**: alternate training backend for the same fine-tunes, so the training code runs on both and the story is real.
- **Databricks**: doc-health analytics across orgs (verified share, mean claim age, time-to-detect, PR merge rate, demand-gap closure), Delta tables fed by de-identified events, MLflow as the alternate registry.

### 6.12 GPU and optimization
- Embedding large repos and docs in batch on a GPU job (Vertex or SageMaker) rather than per-request.
- vLLM for the linker LLM pass and the VLM screenshot judge; AWQ quantization; prefix caching for the conventions skill and page context.
- Measure and publish cost per maintained page per month; a team should see Groundskeeper is cheaper than the hour an engineer spends rediscovering a stale runbook.

### 6.13 Evaluation
- Drift detection: precision, recall, and time-to-detect on synthetic drift across five public repos; report per mutation type.
- Verification correctness: agreement between sandbox verdicts and human verdicts on 200 claims; false-stale rate is the metric users feel most.
- Rewrite quality: judge with a rubric (accurate to code, preserves voice, minimal diff, includes evidence) calibrated on reviewer-merged pages; report judge-human agreement.
- PR acceptance: merged as-is, merged with edits, closed; edit distance between proposed and merged. This is the product metric.
- Historical replay (v3): fraction of real docs changes Groundskeeper would have proposed before the humans did.
- Long-horizon: the nightly loop run for 30 days against a fast-moving OSS repo, measuring budget adherence, no runaway PRs, state correctness, and health-score trend.
- Tooling: LangSmith datasets and experiments, promptfoo in CI for the fast suite, a nightly full suite; regressions block merge.

### 6.14 Observability, CI/CD, security
- OpenTelemetry across services; LangSmith traces per loop run keyed by repo and night; per-model cost logging.
- Monorepo (pnpm and uv); GitHub Actions for lint, types, tests, contract generation, fast evals, container builds, Terraform plan and apply; nightly full evals; trusted-publishing for any CLI. The repo dogfoods Groundskeeper on its own docs from week 6.
- Security: least-privilege GitHub App permissions, per-org isolation, sandboxes with no network by default (allowlist per repo), secrets never enter sandboxes unless the team supplies a staging environment explicitly, source code stored only as long as needed for indexing, SOC 2 readiness checklist from the start because dev-tool buyers ask.

---

## 7. Execution timeline (30 weeks, solo, ~25 hours/week)

| Weeks | Deliverable | Definition of done |
|---|---|---|
| 1 | Monorepo, GitHub App skeleton (Probot), Postgres schema for claims and symbols, CI | App installs on a test org and receives webhooks |
| 2 | Markdown/MDX parser to claims; tree-sitter symbol extraction for Python and TS; exact-match linker | Claim index built for two public repos; link coverage reported |
| 3 | Synthetic drift generator on five public repos; drift mapper (diff → claims); precision and recall reported | Detection metrics per mutation type in the README |
| 4 | Sandbox verification for code blocks, CLI, and links (Docker locally); evidence artifacts | 200 claims verified; false-stale rate measured |
| 5 | LLM fuzzy linker on vLLM; Developer node drafting minimal fixes; PR creation with evidence | First verified drift PR opened on a fork |
| 6 | Change budget; docs-health check on PRs; health report; dogfood on Groundskeeper's own docs | A deliberate drift in the repo produces a verified PR on itself |
| 7 | Hardening: permissions, isolation, no-network sandboxes, rate limits, error states | Security checklist complete; soak on three public repos |
| 8 | **v1 launch**: free for public repos; blog post with detection and verification numbers; outreach to ten OSS maintainers | Installed on five external public repos |
| 9 to 10 | Temporal nightly loop; LangGraph Planner/Developer/QA with SKILL.state; evidence bundles | 14-night run on a fast-moving repo within budget |
| 11 to 12 | Visual DAM on GCS with provenance; Playwright screenshot regeneration; SSIM and VLM judge | Stale screenshot detected and regenerated in a PR |
| 13 to 14 | Docs MCP server with freshness metadata; gap logging; demand signals from Slack and one support desk | Zero-result queries appear in the Planner's backlog |
| 15 to 16 | Confluence or Notion target; Payload CMS adapter (draft-only writes); dashboard v1 (Next.js) | Wiki page and CMS page maintained end to end |
| 17 to 18 | **v2 launch**: private repos paid; pricing per maintained page or per repo; case studies from OSS | Three paying teams or clear pipeline |
| 19 to 21 | Conventions wiki: trace layer, maintainer agent, skill proposer, gated eval, rollback | Evolved skill measurably closer to reviewer-merged pages on held-out edits |
| 22 to 24 | Fine-tunes: claim linker bi-encoder and staleness classifier on Vertex AI and SageMaker; MLflow registry; CI model promotion | Fine-tuned linker beats exact-plus-LLM on held-out links; classifier cuts false flags |
| 25 to 26 | Historical replay eval on five repos; publish the numbers | Replay report in the repo |
| 27 to 28 | Databricks health analytics; batch GPU embedding for large repos; Contentful and Sanity adapters | Analytics notebook pack shipped |
| 29 to 30 | GitLab support; **v3 launch** and technical write-up | Ten paying teams or three well-known OSS projects |

If you are behind at week 8, cut the fuzzy linker to exact-match only; verification-by-execution is the launch story, not link coverage. If you are behind at week 18, drop the CMS adapters before you drop the conventions wiki.

## 8. Go-to-market and adoption loop

- Beachhead: OSS projects with real tutorials and active maintainers. Free, visible, and every PR Groundskeeper opens is a public demo with evidence attached.
- Paying segment: developer-tool companies and platform teams, whose docs are part of the product and whose support load is a direct function of doc accuracy. Sell on verified-claim share and support deflection, not on "AI docs."
- Hooks: the docs-health check badge, the docs MCP server (agents get fresher answers, teams see what agents ask), and the screenshot regeneration demo, which no competitor shows.
- Adoption loop: more repos → more reviewer edits → better conventions and better linker → higher PR merge rate → more repos. Publish merge-as-is rate publicly once it is good.

## 9. Costs (monthly, rough)

- v1: Cloud Run and Cloud SQL small (~$50 to $90), GCS (~$5), sandbox minutes on E2B or Modal (~$20 to $60 at low volume), model API spend (~$30 to $80), GitHub App free. Under $250.
- v2: add Temporal Cloud (~$100 or self-host), a GPU for vLLM in bursts (~$0.50 to $1.20 per hour), browser pool minutes, LangSmith. $400 to $700.
- v3: add Vertex and SageMaker training in bursts (spot), Databricks serverless pay-per-use, Vector Search. $600 to $1,000 in launch months.

## 10. Risks and how to handle them

| Risk | Mitigation |
|---|---|
| Mintlify or GitBook ships execution-based verification | Move faster on the whole-surface and screenshot story; keep the MCP serving loop, which they cannot copy without owning demand signals; sell to teams not on their platforms |
| False-stale PRs annoy maintainers and get the app uninstalled | Verification before PR is a hard gate; low default budget; false-stale rate tracked and shown; "unverifiable" is a status, never a PR |
| Sandboxes are slow or unsafe | E2B or Modal for isolation and cold-start speed; no network by default; runnable blocks opt-in via a marker for the first weeks on each repo |
| Docs without runnable content cannot be verified | Honest "unverifiable" status; link and symbol checks still apply; screenshot verification covers UI docs |
| Reviewer edits are too few to learn conventions | Start conventions from explicit config plus the repo's existing style; the wiki improves on evidence, it does not depend on it |
| Low willingness to pay for docs | Anchor pricing to support deflection and engineer hours, and sell verified-claim share as a health metric leadership sees; OSS stays free and drives distribution |
| Solo scope across many integrations | Version fences: one target of each kind before a second; adapters share one interface and a conformance suite |

## 11. Tool coverage map

| Your list | Where it lives in this plan |
|---|---|
| MCP | 6.8 docs MCP server; 5.2 Confluence and Notion via MCP where available; MCP query log as a demand signal |
| Pre-trained models in an application | 6.2 code-aware embeddings, DeBERTa/ModernBERT staleness classifier; 6.4 Qwen-VL screenshot judge; open models on vLLM |
| Robust AI evals | 6.13 synthetic drift, verification agreement, rewrite judge calibration, PR acceptance, historical replay, 30-night long-horizon run |
| LLM | Throughout; model router in 6.5 |
| Workflow automation | 6.10 Temporal nightly loop, verification jobs, PR lifecycle, audits |
| Cloud AI/ML services (Databricks, SageMaker, Vertex AI) | 6.11 Vertex training and Vector Search; SageMaker alternate training; Databricks health analytics and MLflow |
| LangGraph, LangChain, LangSmith | 6.5 maintenance graph with checkpointer; 6.13 and 6.14 datasets and traces |
| APIs and backend development | 6.1 NestJS product API and GitHub App; FastAPI ML service; CMS management APIs |
| Tool and function calling | 6.5 eight typed tools |
| PyTorch, Hugging Face | 6.2 bi-encoder and classifier fine-tunes with sentence-transformers and HF Trainer |
| Optimizations, GPU computing | 6.12 batch embedding, vLLM with AWQ and prefix caching, cost per page; SKILL.state keeps the loop bounded |
| CI/CD | 6.14 Actions with eval gates, model promotion, dogfooding on the repo's own docs |
| AI system design | Section 4; independent QA (6.4); change budget (6.1); explicit state (6.5) |
| RAG pipelines | 6.8 hybrid retrieval with reranking and freshness metadata |
| TypeScript | 6.1 GitHub App and API; 6.8 MCP server; 6.9 CMS adapters; dashboard |
| CMS | 6.9 Payload, Contentful, Sanity adapters with draft-only writes; Payload for Groundskeeper's own content |
| DAM | 6.7 versioned visual asset store with provenance, driving screenshot and diagram maintenance |

## 12. First ten tasks (this week)

1. Pick five public repos with permissive licenses, runnable tutorials, and active commit history (candidates: a CLI tool, a Python SDK, a TypeScript framework, a web app with a UI, and a data tool). Clone them.
2. Write the claim schema (Pydantic and Prisma) before writing any parser.
3. Build the Markdown/MDX parser to claims with remark; inspect 50 claims by hand from two repos.
4. Wire tree-sitter symbol extraction for Python and TypeScript; count exact-match links per repo.
5. Write the synthetic drift generator with five mutation types; produce labeled drift sets for the five repos.
6. Write the diff-to-claims mapper and report precision and recall on the synthetic sets.
7. Build the Docker sandbox runner for code blocks with expected-output comparison; verify 100 claims.
8. Scaffold the Probot GitHub App and receive push webhooks on a test org.
9. Set up the monorepo, CI with lint and tests, and the Postgres schema with migrations.
10. Write the change-budget config schema and the rule that Groundskeeper never commits to a default branch; put it in the README as a promise.

Ship verified drift PRs on public repos in eight weeks. Everything else is iteration on a thing maintainers can already install.
