# Alpha Release Readiness

Date: 2026-08-31. Scope: UI polish and release preparation for `v0.1.0-alpha`.
No release/tag was created, package versions were not changed, and no planner,
Agent, safety, browser, or benchmark architecture was changed.

## Review Decision

Ready for final human review with the limitations below, not a claim that all
external exploration objectives succeed. The small product smoke matrix exercised
all eight requested cases. The real-world exploration case executed autonomously
but did not complete its objective; its failure was correctly labeled as an Agent
execution error rather than a confirmed target-site bug.

## Product Changes

- New Test now presents target URL before the three product modes and objective.
- Functional/Regression expected text is explicitly contextual to the final check;
  Exploratory expected text is optional. Temporary login remains optional.
- Outcomes distinguish target findings, assertion failures, safety stops, pending
  approval, unsupported objectives, and Agent/model/browser/local setup errors.
- Reports expose mode, target, duration, findings, evidence, and a readable stop
  reason. Raw execution detail and timeline are expandable.
- Synthetic failed/unexecuted steps are not counted or analyzed as website bugs.
  Independent console and assertion findings remain visible.
- Missing saved runs have a friendly recovery page. Dashboard, History, the
  saved-run selector, and New Test retain their existing routes.

These changes interpret existing evidence for display. They do not replace the
Evaluator, alter raw artifacts, or change the frozen execution policy.

## Approval UI Decision

Deferred. Core Agent/TestTask approval callbacks support same-session resume,
as recorded in [safety acceptance](ALPHA_SAFETY_ACCEPTANCE.md). The product executor
currently closes its browser in cleanup; Exploratory does not share the Functional
TestTask approval callback lifecycle. A product approval endpoint would require
retained ownership of live requests and sessions, consent expiry, secure request
routing, and abandoned-run/shutdown cleanup in both modes. That is not a small
presentation change.

The Alpha dashboard therefore ends approval-required runs safely, reports that
the sensitive action was not executed, and does not imply that a resume button or
waiting browser exists. No approval was automatically granted in this smoke run.

## Final Smoke Matrix

Cases A-G entered through the normal New Test UI and backend. H used the same
request path with an intentionally invalid response injected through the existing
exploration-client dependency, solely to verify error presentation. H is not a
claim that the live Ollama service failed.

| Case | Scenario / execution path | Product outcome | Browser actions / evidence |
| --- | --- | --- | --- |
| A | Benchmark login-page text, Functional deterministic | Passed | Body read; 2 screenshots; 0.59s |
| B | Existing native-form fixture, Functional deterministic | Passed | Wait, type, wait, text check; 5 screenshots; 2.12s |
| C | QA Practice, Exploratory Adaptive V2 | Agent execution error | 2 navigations, 3 states, 3 screenshots; 33.75s |
| D | Benchmark temporary login, Functional deterministic | Passed | 5 actions; login and dashboard; 6 screenshots; 1.21s |
| E | Existing local fixture: Delete account | Blocked by safety | Zero destructive clicks; 3 screenshots; 1.52s |
| F | Existing local fixture: Submit settings | Approval required | Zero submissions; 3 screenshots; 1.48s |
| G | Unsupported Functional objective: Buy all products | Unsupported objective | Rejected before browser execution; no report/screenshots expected |
| H | Injected malformed model response, Exploratory | Model execution error | 1 injected call, zero actions; 1 screenshot; 0.89s |

E/F performed only their preceding wait/type actions. Requested but unexecuted
steps remain in the trace; their presence is not counted as proof of execution.
All eight cases reported zero target-site findings. In C this does not mean the
visited pages were healthy: see the external validation details below.

## Real-World Exploration

Target: `https://www.qapractice.com/`. Objective: explore as a first-time user,
navigate safe pages, look for visible failures, avoid destructive/sensitive actions,
and collect evidence. Expected visible text was empty.

- Selected strategy: Adaptive V2, with an opportunity-preserving early handoff.
- Live model: `qwen2.5-coder:7b`, through `http://127.0.0.1:11434`.
- Model invocations: 2. Actual post-start browser actions: 2 navigations, no clicks.
- Visited URLs/states: homepage, `/PracticePage`, and `/interview` (3 states).
- Duration: 33,752ms. Screenshots: 3. Automatic findings: 0.
- Termination: `agent-error`.

The second action requested `/interview-preparation`, which redirected to
`/interview`. Existing navigation verification reported:

```text
Navigation expected https://www.qapractice.com/interview-preparation but reached https://www.qapractice.com/interview.
```

The `/PracticePage` screenshot also visibly contained a 404 page. This was not
automatically raised as a finding and is not presented here as a confirmed website
bug: model-selected navigation and limited detection remain possible causes.
The dashboard accurately shows incomplete Agent execution and retains the evidence.
Redirect handling and model/detection quality were not changed in this UI milestone.

## Navigation, Layout, And Security

- Dashboard selected the latest readable run; History, Run Details, saved-run
  selection, and New Test worked. Missing-run requests returned a friendly 404.
- New Test, History, and the approval-result view were checked at 390, 800, 1024,
  and 1440px widths, including expanded technical details. No horizontal overflow,
  clipped checked labels/headings/navigation, or browser page errors were detected.
  Additional result views were checked at 390/1440px; screenshots were inspected.
- Login evidence masked both credential fields. The supplied fixture values were
  absent from request serialization, reports, traces, rendered details, and analysis.
  Safety counters recorded zero destructive clicks and zero submissions.
- All smoke-owned test browsers and temporary servers closed. A separate local
  dashboard was started for review. Generated evidence remains gitignored.
- Ollama health/model availability passed at the IPv4 default. Default execution
  and local analysis required no paid API credentials.

These checks cover the supplied temporary credentials, not every possible kind of
sensitive content a third-party page could display. Safety remains a heuristic
guardrail rather than a hardened security boundary.

## Evidence References

Local-only evidence is under `run-output/alpha-release/`: `smoke-summary.json`,
`view-check.json`, and UI screenshots. Raw browser evidence is under
`run-output/demo/<run-id>/` (`report.json`, `trace.json`, and `screenshots/`).
No generated evidence is committed.

| Case | Run ID |
| --- | --- |
| A | `2026-08-31T08-49-06-962Z-request-add4e089` |
| B | `2026-08-31T08-49-08-428Z-request-aea25b58` |
| C | `2026-08-31T08-49-12-131Z-request-ee8a6f49` |
| D | `2026-08-31T08-50-54-357Z-request-5f03544d` |
| E | `2026-08-31T08-50-57-266Z-request-5fa72064` |
| F | `2026-08-31T08-51-00-212Z-request-386ff95f` |
| G | No artifact: objective rejected before execution |
| H | `2026-08-31T08-51-04-697Z-request-c4126e09` |

## Repository Verification

| Check | Result |
| --- | --- |
| `npm run build` | Passed |
| `npm test` | 317 tests passed across 43 files |
| `npm run lint` | Passed |
| `npm run format:check` | Passed |

Tests ran with `VITEST_MAX_FORKS=2` and `VITEST_MIN_FORKS=1` to bound local memory,
without excluding test files. Focused tests cover outcome labels, safety/pending
states, recovered executions, request copy, missing-run behavior, and avoiding
target-bug analysis for execution-only failures. Existing core and product tests
remain passing. No large benchmark was rerun.

## Remaining Alpha Limits

- Local-model invalid JSON, invalid targets, and early termination remain possible.
  Target recovery is bounded; exploration can remain incomplete.
- Navigation redirects can fail the existing URL expectation, as measured above.
- Functional objectives/control matching are deliberately bounded; unsupported
  instructions are rejected rather than silently replaced with a text-only test.
- Product approval/resume is deferred; core callback resume remains available.
- Findings and local/AI analysis require human review. Absence of findings is not
  proof of correctness. No multi-user/cloud/persistence infrastructure is added.

See [release notes](RELEASE_NOTES_v0.1.0-alpha.md) and the
[Alpha architecture](ALPHA_ARCHITECTURE.md). Final release/tag creation remains a
separate approval step.
