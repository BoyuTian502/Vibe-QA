# Vibe-QA

**Local website testing with browser evidence. Preparing v0.1.0-alpha for review.**

Vibe-QA operates a real browser, checks what happened, and records screenshots,
actions, and findings for developers and small teams. It complements scripted
tests; it does not certify that a website is bug-free.

## Why It Exists

Small teams ship faster than they can manually retest every page. Vibe-QA combines
repeatable workflow checks with bounded autonomous exploration and keeps the
evidence available for human review. It runs locally, not as a hosted QA service.

## Core Capabilities

- Deterministic page-text, login, navigation, and explicit native-form workflows.
- Autonomous exploration with page-state coverage and bounded target recovery.
- Isolated Playwright sessions and temporary credential redaction.
- Safety decisions before actions: allow, block, or require approval.
- Reports, screenshots, an execution timeline, local history, and optional analysis.

## Testing Modes

| Mode | What runs | Expected visible page text |
| --- | --- | --- |
| Functional | Deterministic supported workflow followed by verification | Required for the local form's final check |
| Regression | Deterministic expectation check | Required for this local check |
| Exploratory | Adaptive V2 exploration; local Ollama only on escalation | Optional additional final-page check |

There is no planner selector in the normal UI. Regression does not yet infer
changes from earlier runs. Functional objectives are bounded commands, not
arbitrary prose understood by a model.

## Architecture

```mermaid
flowchart TD
    User --> Entry["Dashboard / CLI"]
    Entry --> Configuration["Target, mode, objective, optional login"]
    Configuration --> Mode{"Mode selection"}
    Mode -->|Functional| Engine["Deterministic workflow"]
    Mode -->|Regression| Engine
    Mode -->|Exploratory| Adaptive["Adaptive V2"]
    Adaptive <-->|Escalation only| Ollama["Local Ollama"]
    Engine --> Agent["Agent / Explorer"]
    Adaptive --> Agent
    Agent --> Safety{"Safety Policy"}
    Safety -->|Allow| Browser["Playwright"]
    Safety -->|Block or approval required| Stop["Safe product stop"]
    Browser <--> Site["Target site"]
    Agent --> Evidence["Trace / Screenshots / Report"]
    Stop --> Evidence
    Evidence --> Dashboard["Dashboard / History / Run Details"]
```

Core Agent approval/resume remains available through the developer callback API.
The dashboard safely stops and closes the browser on approval-required actions;
it does not offer interactive resume. See [Alpha Architecture](docs/ALPHA_ARCHITECTURE.md).

## Local Setup

Use Node.js 18 or later, npm, and a supported Chrome/Chromium installation.
From the repository root:

```bash
npm ci
npm run build
```

The existing browser adapter can use installed Chrome. Without a system browser:

```bash
npx playwright install chromium
```

No paid API key is needed for default Alpha execution.

## Ollama Setup

Exploratory escalation uses the local model `qwen2.5-coder:7b`. Install/start
Ollama and make that model available:

```bash
ollama pull qwen2.5-coder:7b
ollama list
```

The default is IPv4 loopback to avoid Windows/Node resolving `localhost` to
an unsupported IPv6 listener. An environment override is supported:

```ini
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

Set this in the dashboard process environment; no committed environment file is
needed. Functional, Regression, and the default demo do not require Ollama.

## Run The Dashboard

```bash
npm run dashboard:qa
```

Open the printed local URL. A new installation can go straight to **New Test**;
no demo artifacts are required. After updating code, restart the dashboard:
building does not reload an already-running Node process.

## Create A Test

1. Open **New Test** and enter the target URL.
2. Choose **Functional**, **Regression**, or **Exploratory**.
3. Enter the objective and, where applicable, expected visible page text.
4. Enable temporary login only when needed, using the dedicated credential fields.
5. Run the test, then open its report from the status page.

Examples:

- Page check: `Verify that the homepage loads successfully.`
- Login: `Test login functionality`, with temporary credentials and a login-page URL.
- Form: one command per line, such as `Enter Ada in First Name`,
  `Select India as Country`, `Check checkbox Terms`, `Click Submit`.
  Submissions remain subject to approval and may stop safely.
- Exploration: `Explore this website as a first-time user. Navigate safe pages and look for visible failures. Do not perform destructive or sensitive actions.`

Expected text is literal and case-sensitive. Whitespace is collapsed and every
non-empty expected line must appear independently on the final rendered page.
Chinese/Unicode text is preserved. It is not a natural-language expected behavior.

Native form controls and one exact-label navigation target are supported.
Complex login-then-form workflows use the existing structured TestCase API.

## Evidence And Reporting

**Dashboard** opens the latest readable run. **History**, the saved-run selector,
and **Run Details** expose local reports under `run-output/demo/<run-id>/`:

- `report.json`: checks, findings, errors, mode, and execution metadata.
- `trace.json`: observations, actions, safety decisions, and termination details.
- `screenshots/`: real browser evidence, with credential masking.

The summary separates **Passed**, **Issue found**, **Expected result not met**,
**Blocked by safety**, **Approval required**, **Unsupported objective**, and
agent/model/browser/local setup errors. Execution failures are not automatically
called target-site bugs. Technical details remain expandable below the summary.

Actual website findings can include a labeled local analysis baseline. Optional
OpenAI-compatible analysis uses `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and
`OPENAI_MODEL`; it is separate from execution and never required by default.

## Safety And Authentication

Use websites you own or are authorized to test. Risky actions are not implicitly
approved by entering an objective. The local safety policy is a safeguard, not a
hardened network sandbox or a complete understanding of every website's effects.

Temporary credentials stay in memory, are injected at the browser boundary,
redacted from planner/evidence data, and cleared at cleanup. Fresh sessions isolate
runs. Do not put secrets into objectives, expected text, URLs, or committed files.

The [safety acceptance record](docs/ALPHA_SAFETY_ACCEPTANCE.md) verifies blocked
actions, pending approval, credential masking, and same-session callback resume.
The dashboard approval UI is deferred; no browser is kept waiting indefinitely.

## Technical Demo

```bash
npm run demo:qa
npm run demo:qa -- --scenario login
npm run demo:qa -- --keep-open
```

The default demo starts the existing benchmark, opens a visible browser, signs in,
and triggers its seeded fragile-widget error. The failure report is expected.
See the [presenter guide](docs/TECHNICAL_DEMO.md).

## Evaluation Summary

Historical controlled Adaptive V2 checks were 8/8 successful with zero escalation.
The completed 240-execution generalization comparison measured 71.7% expected
outcomes and 35% hidden discovery for Adaptive V2, averaging 10.99s versus 6.45s
for pure Ollama. These are controlled-site measurements, not universal accuracy
or latency claims. No large benchmark was rerun for UI polish.

See [evaluation reference](docs/EVALUATION_REFERENCE.md) for retained commands,
historical comparisons, diagnostics, and limitations.

## Real-World Validation

Alpha checks exercised external SPAs, normalized visible text, native forms, and
QA Practice exploration. Autonomous runs can navigate real pages but do not always
finish the objective. See [release readiness](docs/ALPHA_RELEASE_READINESS.md) for
the final small smoke matrix, exact outcomes, and evidence references.

## Known Alpha Limitations

- `qwen2.5-coder:7b` can return invalid JSON, invalid targets, or stop early.
  Invalid targets receive bounded re-observation/replanning, not unlimited retries.
- Exploration is action-budgeted and may stop without confirming the objective.
- The dashboard cannot approve/resume a stopped run; the developer callback API can.
- Functional support is deliberately bounded. Ambiguous controls may be rejected.
- Findings and analysis are review aids, not confirmed root causes or security audits.
- Local artifacts can be removed or become unreadable; there is no cloud persistence.
- No multi-user service, queue infrastructure, cloud browser, or cross-run website memory.

## Development And Release

```bash
npm run build
npm test
npm run lint
npm run format:check
```

This is release preparation only. Package versions are unchanged and no
`v0.1.0-alpha` tag or GitHub release has been created.
See [release notes](docs/RELEASE_NOTES_v0.1.0-alpha.md).

## Future Work

Interactive product approvals, cross-run website memory, change-based regression
selection, and stronger reproduction evidence remain separate, review-gated work.
No new planner or framework is part of this milestone.
