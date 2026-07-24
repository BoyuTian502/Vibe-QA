# VibeQA Implementation Plan

## 1. Current Understanding

VibeQA is an autonomous website-testing agent for indie developers, small teams, and vibe-coding users who need release confidence without a dedicated QA function.

The Alpha-0 product is not a production SaaS platform and not a general test-code generator. It is a local prototype that proves a stateful agent can use one controlled benchmark web application, run bounded browser experiments, detect seeded bugs, reproduce failures, and produce evidence-backed reports.

The benchmark target should be a small SaaS-style application rather than a minimal todo list. It should still be local and deterministic, but it should resemble the kind of product VibeQA is intended to test: authentication, dashboard, CRUD workflows, settings, realistic navigation, and a few connected business objects. This gives Alpha-0 enough surface area to validate page-state modeling, workflow discovery, and regression-style exploration without expanding into a real SaaS product for VibeQA itself.

The intended Alpha-0 interface is a local CLI:

```bash
npm run vibeqa -- \
  --url http://localhost:3000 \
  --description "A simple project management app" \
  --mode exploration \
  --storage-state .auth/test-user.json \
  --max-actions 40
```

The expected run output is local artifact storage:

```text
run-output/
  report.json
  report.md or report.html
  bugs.json
  actions.jsonl
  observations.jsonl
  trace.zip
  screenshots/
```

The architecture is:

```text
One stateful LangGraph.js workflow
+ one isolated Playwright Chromium browser worker
+ deterministic safety and observation layers
+ LLM calls only at semantic decision points
```

Core engineering rules from the product specification:

- Use TypeScript across the Alpha-0 stack.
- Use Playwright for browser control.
- Use LangGraph.js for orchestration and persistent state.
- Use Zod at every LLM and tool boundary.
- Never allow the LLM to execute arbitrary browser code.
- Browser actions must use a typed allow-listed interface.
- Never expose passwords or authentication tokens to the LLM.
- Enforce safety deterministically before browser actions.
- Store large artifacts outside graph state and keep references in state.
- Keep the implementation narrow, local, measurable, and benchmark-driven.

Alpha-0 succeeds when the prototype repeatedly tests the controlled benchmark app, completes the critical happy path in at least 9 of 10 runs, detects the seeded persistence bug in at least 8 of 10 runs, detects deterministic HTTP 500 errors in at least 9 of 10 runs, captures uncaught console exceptions, obeys safety restrictions, produces reproducible evidence, and stops under the action budget.

Future Alpha-1 work should add Website Memory: persistent knowledge of previously discovered page states, workflow outcomes, and application fingerprints across runs. This memory should allow VibeQA to compare application changes between runs and prioritize regression testing around changed or previously fragile areas. Website Memory is an architectural extension point, not an Alpha-0 implementation requirement.

## 2. Alpha-0 Implementation Strategy

The implementation should proceed from deterministic foundations toward agent autonomy.

First, create the TypeScript workspace, schemas, local scripts, and benchmark app. The benchmark app is the measurement target and must exist before the agent can be evaluated. It should be simple, resettable, and intentionally seeded with the bugs listed in `MVP_SCOPE.md`.

Second, implement the Playwright browser worker as the only layer allowed to touch the browser. The worker should expose typed commands such as `observe`, `navigate`, `click`, `fill`, `select`, `refresh`, `go_back`, `assert`, and `reset`. The LLM should only receive opaque element IDs and semantic metadata, never raw authority to create selectors or execute code.

Third, implement shared Zod schemas for run configuration, state, observations, elements, experiments, anomalies, investigations, and bug reports. These schemas should be used by the CLI, worker, orchestrator, logs, persisted state, and report generator.

Fourth, build hybrid hypothesis generation around deterministic experiment templates and LLM semantic exploration. Deterministic templates should generate baseline hypotheses for known bug classes and core regression checks. LLM calls should generate semantic exploration hypotheses from observed product structure, visible workflows, and the supplied application description. Alpha-0 should prove that the core loop can run with controlled deterministic inputs before enabling broader semantic hypothesis generation.

Baseline deterministic hypotheses should cover:

- Valid create
- Empty create
- Whitespace-only create
- Long-text create
- Create-refresh-verify
- Logout-revisit-protected-route
- Duplicate submit
- Broken navigation check

Semantic exploration hypotheses should cover product-specific questions such as:

- Which dashboard actions look primary or risky?
- Which settings changes could alter user-visible behavior?
- Which workflows appear unfinished, blocked, or inconsistent?
- Which newly discovered states should be mapped before deeper testing?

Fifth, wire the LangGraph.js workflow using deterministic stubs for semantic nodes. The graph should initialize the run, validate policy, prepare the browser, authenticate from storage state, observe, select experiments, execute, detect anomalies, investigate, update coverage, evaluate stop conditions, and generate reports.

Sixth, add LLM calls only where the documents allow them:

- Page-purpose interpretation
- Feature and workflow inference
- Mission generation
- Hypothesis generation
- Ambiguous anomaly interpretation
- Report wording

LLM outputs must be structured, Zod-validated, compact, secret-free, and retried at most once for schema repair.

Seventh, implement deterministic anomaly detection and reproduction. High-confidence technical failures should not depend on LLM judgment. Confirmed bugs must include reproduction steps, screenshots or trace references, console or network evidence where relevant, expected behavior, actual behavior, severity, confidence, and a developer fix prompt.

Eighth, implement a Human Approval Loop for risky actions. The deterministic safety gate should return `allow`, `block`, or `require_approval`. When approval is required, the LangGraph workflow should pause, preserve state, present the proposed action and risk reason, and resume only after approval. Alpha-0 can keep this local and CLI-based.

Ninth, add the evaluation harness that runs the agent 10 times against a reset benchmark app and reports completion rate, bug recall, bug precision, action count, LLM calls, runtime, flakiness, safety violations, state coverage, workflow coverage, hypothesis diversity, and exploration quality.

## 3. Proposed Repository Structure

Use the repository structure already described in `README.md` and `DEVELOPMENT_PLAN.md`:

```text
vibeqa/
  apps/
    benchmark-app/
      src/
      tests/
      bug-manifest.json
      package.json
    cli/
      src/
      package.json
    worker/
      src/
      package.json
  packages/
    schemas/
      src/
      package.json
    prompts/
      src/
      package.json
    browser-tools/
      src/
      package.json
    test-fixtures/
      src/
      fixtures/
      package.json
  docs/
    PRD.md
    ARCHITECTURE.md
    AGENT_DESIGN.md
    MVP_SCOPE.md
    DEVELOPMENT_PLAN.md
    IMPLEMENTATION_PLAN.md
  package.json
  tsconfig.base.json
  eslint.config.*
  prettier.config.*
  vitest.config.*
```

Package responsibilities:

- `apps/benchmark-app`: controlled authenticated SaaS-style benchmark app with dashboard, CRUD workflows, settings, realistic navigation, resettable seeded bugs, and a hidden ground-truth bug manifest.
- `apps/cli`: local Alpha-0 command entry point, argument parsing, config validation, run startup, progress output, and process exit status.
- `apps/worker`: isolated Playwright Chromium browser worker, typed command execution, safety gate integration, evidence capture, traces, screenshots, console and network recording.
- `packages/schemas`: Zod schemas and TypeScript types for every persisted object, LLM boundary, and tool boundary.
- `packages/browser-tools`: element registry, locator descriptors, observations, safety policy checks, action records, artifact references, and test-data value resolution.
- `packages/prompts`: versioned prompts for allowed semantic nodes only.
- `packages/test-fixtures`: deterministic data categories and safe upload fixtures used by experiments.

The first implementation should use local filesystem storage for `run-output/`. SQLite can be introduced only where persistent run state or checkpointing materially needs it during Alpha-0; PostgreSQL, S3, Redis, BullMQ, and cloud browser infrastructure remain out of scope.

Alpha-1 may add a `packages/website-memory` module or equivalent persistence layer for previous page states, workflow outcomes, regression history, and application-change fingerprints. It should remain separate from Alpha-0's minimum benchmark proof until the prototype meets its acceptance criteria.

## 4. Development Milestones

### Milestone 0: Repository Foundation

Create the strict TypeScript workspace, formatting, linting, tests, shared configs, and basic package boundaries.

Exit criteria:

- All packages compile.
- Unit-test command runs.
- CLI prints help.
- Benchmark app can start locally.

### Milestone 1: Benchmark SaaS-Style Website

Build the controlled authenticated benchmark app as a small SaaS-style product with login, dashboard, CRUD features, settings, realistic navigation, and logout.

The app should be richer than a todo list while still deterministic. A suitable shape is a lightweight project workspace with:

- Login and authenticated dashboard
- Project or task records with create, read, update, and delete flows
- A settings page with safe editable preferences
- Navigation between dashboard, item detail, edit form, settings, and logout
- Realistic empty states, form validation, loading states, and error states
- A dedicated test account and resettable local data

Seed the required bugs:

- `BUG-BENCH-001`: created item disappears after refresh.
- `BUG-BENCH-002`: dashboard still exposes private content after logout direct navigation.
- `BUG-BENCH-003`: whitespace-only names are accepted.
- `BUG-BENCH-004`: designated valid action triggers HTTP 500.
- `BUG-BENCH-005`: specific interaction triggers uncaught JavaScript exception.
- Optional only if time allows: `BUG-BENCH-006` long text layout break.

Exit criteria:

- Each seeded bug is manually reproducible.
- Reset script restores deterministic state.
- Ground-truth tests verify seeded bugs exist.

### Milestone 2: Browser Worker

Implement isolated Chromium control through typed commands only.

Exit criteria:

- Storage state can be loaded.
- The worker can observe, navigate, click, fill, select, refresh, go back, assert, and reset.
- Screenshots, traces, console events, network events, actions, and observations are captured.
- Allowed-origin and destructive-action safety checks run before each browser action.

### Milestone 3: Schemas and Persistent State

Implement Zod schemas for the run configuration, website test state, page states, elements, observations, missions, expected behaviors, hypotheses, experiments, anomalies, investigations, bug reports, coverage, evidence refs, and errors.

Exit criteria:

- Every persisted object validates.
- Invalid LLM output is rejected.
- State can be saved and restored without embedding large artifacts.

### Milestone 4: Deterministic Experiment Engine

Implement the initial experiment templates and test-data factory. These templates generate baseline hypotheses for core bug classes without requiring an LLM.

Exit criteria:

- Each experiment can run without an LLM when given correct element IDs.
- Each experiment has preconditions and assertions.
- Each experiment can restore or reset to a known checkpoint.

### Milestone 5: Initial LangGraph Workflow

Wire the graph nodes described in `AGENT_DESIGN.md`, initially with deterministic semantic stubs.

Exit criteria:

- A full run can complete.
- The graph loops through multiple experiments.
- Budget and stop conditions are enforced.
- A valid report is generated with or without bugs.

### Milestone 6: LLM Semantic Nodes

Add LLM calls only for approved semantic decision points. LLM nodes should generate semantic exploration hypotheses that complement, rather than replace, deterministic baseline hypotheses.

Exit criteria:

- The agent identifies the create-item feature.
- The agent generates a persistence hypothesis.
- The agent generates at least one semantic hypothesis tied to the observed dashboard, CRUD flow, or settings page.
- The agent selects safe high-value experiments.
- LLM-call budget and schema validation are enforced.

### Milestone 7: Human Approval Loop

Implement a local approval pause for risky actions.

Risky actions include:

- Delete operations
- Account, workspace, or project removal
- Settings changes that appear irreversible
- Actions that send, publish, invite, deploy, charge, cancel, or affect external users
- Any action matching user-provided restrictions

Exit criteria:

- The safety gate can return `allow`, `block`, or `require_approval`.
- The graph pauses with a clear approval request before risky actions.
- State is preserved while awaiting approval.
- Denied actions are recorded and skipped or replaced with a safe alternative.
- Blocked actions are never executed.

### Milestone 8: Anomaly Detection and Investigation

Implement deterministic anomaly rules and reproduction.

Exit criteria:

- Persistence failure is confirmed.
- HTTP 500 is confirmed.
- Uncaught client exceptions are captured.
- Normal loading below threshold is not reported as a bug.
- Flaky or non-reproducible anomalies are not mislabeled as confirmed.

### Milestone 9: Reporting

Generate developer-oriented local reports.

Exit criteria:

- `report.json`, `report.md` or `report.html`, `bugs.json`, `actions.jsonl`, `observations.jsonl`, screenshots, and trace references are valid.
- Each confirmed bug includes evidence and a fix prompt.
- Reports remain useful when no bugs are found.

### Milestone 10: Evaluation Harness

Run repeated benchmark evaluations.

Exit criteria:

- `npm run evaluate -- --runs 10` records repeatable metrics.
- Results show critical-flow completion, bug recall, bug precision, action count, LLM calls, runtime, flakiness, safety violations, state coverage, workflow coverage, hypothesis diversity, and exploration quality.
- Regressions in agent behavior are detectable.

### Future Alpha-1: Website Memory

Add persistent memory across runs after Alpha-0 is reliable.

Website Memory should store:

- Previously discovered page states and fingerprints
- Known workflows and transitions
- Historical bug findings and rejected anomalies
- Prior coverage results
- Changed, added, removed, or unstable states between runs

Alpha-1 should use this memory to:

- Compare the current application against prior runs
- Prioritize regression testing around changed states
- Re-test previously failing or fragile workflows
- Reduce repeated low-value exploration
- Improve report context by identifying new versus recurring failures

Website Memory must not store secrets, raw credentials, or sensitive authentication artifacts.

## 5. Technical Risks

- Locator brittleness: UI changes may invalidate selectors. Mitigation: prefer role and accessible name, then labels, placeholders, test IDs, stable visible text, and only then stable CSS fallback.
- Agent overreach: an LLM might attempt unsafe or irrelevant actions. Mitigation: typed actions, opaque element IDs, deterministic safety gate, action budget, and no arbitrary browser code.
- False positives from inferred behavior: low-confidence expectations may be mislabeled as bugs. Mitigation: source-ranked expected behavior, deterministic technical rules, reproduction, confidence scoring, and clear classification.
- Flaky browser state: stale elements, async loading, and SPA transitions can create inconsistent outcomes. Mitigation: observations after meaningful actions, retry caps, checkpoint restore, reset scripts, loading thresholds, and stale-element recovery.
- Secret leakage: credentials or storage state could enter prompts, logs, traces, or reports. Mitigation: secret references, direct worker resolution, redaction, and no secret data in LLM context.
- Artifact bloat in state: screenshots, videos, and traces can make graph state unusable. Mitigation: local artifact files with references in state.
- Benchmark bias: the agent could become tuned only to the seeded app. Mitigation: keep benchmark deterministic for Alpha-0 but structure experiments, schemas, and observations around general web-testing concepts.
- Benchmark complexity drift: a SaaS-style benchmark could grow beyond Alpha-0 needs. Mitigation: include dashboard, CRUD, settings, and realistic workflows, but keep data local, routes known, and seeded bugs deterministic.
- Approval-loop dead ends: frequent pauses could prevent useful autonomous testing. Mitigation: classify only genuinely risky actions as `require_approval`, use safe alternatives when denied, and keep blocked actions visible in reports.
- Weak semantic exploration: LLM-generated hypotheses may duplicate deterministic templates or chase low-value UI. Mitigation: score deterministic and semantic hypotheses together using novelty, coverage gain, risk, importance, safety, and estimated action cost.
- Website Memory leakage: future cross-run memory could retain sensitive state. Mitigation: store fingerprints, page-state summaries, workflow outcomes, and artifact references only; exclude secrets and authentication files.
- Scope creep: SaaS, billing, auth platform, cloud workers, queues, and integrations could distract from Alpha-0 success. Mitigation: defer all excluded capabilities until after benchmark success is measured.
- LLM nondeterminism: semantic decisions may vary between runs. Mitigation: deterministic stubs first, structured prompts, schema validation, compact context, stable scoring, and evaluation over 10 runs.
- Report incompleteness: a bug without reproduction or evidence is not useful. Mitigation: require evidence refs, steps, expected and actual behavior, confidence, severity, and trace or screenshot references before confirming.

## 6. Dependencies Required

Required Alpha-0 runtime and build dependencies:

- Node.js
- TypeScript
- Playwright
- LangGraph.js
- Zod
- Commander or equivalent CLI parser
- Vitest
- ESLint
- Prettier
- Structured logger such as Pino
- Environment validation, preferably through Zod-backed configuration

Likely benchmark-app dependencies:

- A minimal TypeScript web stack suitable for local deterministic testing
- Local data persistence or in-memory resettable storage
- Test utilities for ground-truth bug verification

Optional Alpha-0 dependency, only if persistent graph checkpoints need it:

- SQLite

Explicitly excluded for Alpha-0:

- PostgreSQL
- Redis
- BullMQ
- S3
- SaaS frontend framework for production UI
- Billing providers
- Authentication platform
- Multi-browser services
- Mobile emulation services
- Jira, Slack, or CI/CD integrations
- Browser automation frameworks outside Playwright

Future Alpha-1 dependency candidates:

- SQLite or another local persistent store for Website Memory
- Schema migration tooling if memory format changes across versions

## 7. First Five Git Commits

1. `chore: initialize strict TypeScript workspace`

   Create the monorepo/workspace, shared TypeScript config, linting, formatting, Vitest setup, package scripts, and placeholder package boundaries. The CLI should print help, and the workspace should compile.

2. `feat: add benchmark SaaS-style app with resettable seeded bugs`

   Build the controlled authenticated SaaS-style benchmark app with dashboard, CRUD workflows, settings, dedicated test account, reset script, known routes, hidden bug manifest, and ground-truth tests for the required seeded bugs.

3. `feat: implement typed Playwright browser worker`

   Add isolated Chromium lifecycle management, storage-state loading, allowed-origin enforcement, element registry, typed browser commands, screenshots, traces, console and network capture, and JSONL action and observation logs.

4. `feat: add agent state schemas and run persistence`

   Implement Zod schemas and TypeScript types for the documented state model, observations, experiments, anomalies, investigations, bug reports, evidence refs, coverage, run config, and persisted state.

5. `feat: add hybrid experiment loop and reporting`

   Implement deterministic experiment templates, semantic hypothesis stubs, scoring across baseline and semantic hypotheses, stop conditions, anomaly detection for seeded technical failures, reproduction scaffolding, local approval pauses for risky actions, and local report outputs.

## 8. Approval Checkpoint

No application code should be implemented until this plan is reviewed and approved.
