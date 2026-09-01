# Alpha Runtime Stability Report

Date: 2026-09-01. Scope: stability hardening before `v0.1.0-alpha` review.
This is a bounded acceptance matrix, not a general model-quality benchmark. No
release or tag was created.

## Runtime Defects Addressed

- Invalid local-model output now receives at most two correction attempts under
  the same strict `BrowserAction` contract. Each invalid response is represented
  by a SHA-256 hash, redacted preview, and sanitized validation reason.
- Exhausted correction returns typed `MODEL_OUTPUT_INVALID`; no action is guessed,
  extracted from prose, or executed.
- Model prompts require one JSON object or `null`, prohibit prose and extra fields,
  and list targets from the latest observation only.
- Current-observation action targets are validated before Agent recovery. A target
  from an earlier observation is invalid after page state changes.
- BrowserSession no longer falls back to ambiguous bare tag selectors such as
  `a`. It prefers a unique ID, name, href, or ARIA selector, then a deterministic
  unique DOM path.
- Ambiguous observed links are presented to the model as exact `navigate` targets
  using their observed `href`, rather than as unsafe shared-selector clicks.
- Transient read/navigation browser errors receive one bounded retry with typed
  report/trace metadata. Clicks, typing, safety decisions, denied approvals,
  authentication failures, and unsupported actions are never automatically replayed.
- Product outcomes distinguish model-output exhaustion, target-recovery exhaustion,
  browser failure, agent failure, safety block, and approval pause.

## Repeatability Matrix

All runs used normal product execution through `AgentTestRequestExecutor` and a
fresh Playwright browser session. QA Practice exploration used local Ollama with
`qwen2.5-coder:7b`. Generated reports and screenshots stayed under ignored
`run-output/`.

| Cohort | Runs | Result | Mean duration |
| --- | ---: | --- | ---: |
| Functional visible text | 5 | 5 passed | 0.586 s |
| Functional native form | 5 | 5 passed | 2.034 s |
| Temporary authenticated login | 5 | 5 passed | 1.223 s |
| QA Practice exploratory | 10 | 1 passed, 9 controlled stops | 44.192 s |
| Safety block | 3 | 3 blocked before execution | 1.472 s |
| Approval required | 3 | 3 paused before execution | 1.491 s |
| **Total** | **31** | **16 passed, 15 controlled stops, 0 crashes** | **15.162 s** |

The final exploratory distribution was:

- 1 `candidate-exhausted` completion.
- 6 `MODEL_OUTPUT_INVALID` stops.
- 2 approval-required pauses; no sensitive action was executed.
- 1 `null-retry-exhausted` stop; useful candidates remained and completion was
  not claimed.

The three Safety block runs and three approval-required form runs are expected
controlled outcomes, not product failures or target-site bugs.

## Recovery And Grounding

- 67 local-model calls produced 31 invalid responses (46.3%).
- Bounded correction recovered 8 malformed-output sequences; 6 sequences exhausted
  the limit. Recovery was therefore 8/14 (57.1%) among sequences that encountered
  malformed output.
- `MODEL_OUTPUT_INVALID` ended 6/31 total runs (19.4%) and 6/10 exploratory runs
  (60%). This remains a material local-model limitation.
- The final post-fix exploratory cohort recorded 0 invalid current-page targets and
  0 stale-target recovery attempts. Target-recovery rate is therefore not applicable;
  no invalid target was allowed through the grounding boundary.
- One bounded `null-retry-exhausted` outcome correctly remained an Agent error rather
  than being reported as successful completion.
- No final-matrix browser/action failure occurred. A focused pre-matrix diagnostic
  captured a real pointer-interception timeout and classified it as `BROWSER_ERROR`
  without replaying the click.

## Cleanup And Data Handling

The instrumented matrix observed 31 browser launches and 31 closes, including
success, model failure, safety block, approval pause, and browser-failure paths.
The executor cleanup remains in `finally`; transient retry and grounding wrappers
do not own or bypass browser shutdown.

Credential scans found no submitted username, password, or session cookie in the
saved report/trace data. Temporary values are injected at the browser boundary,
masked in screenshots, redacted from diagnostics, and cleared during cleanup.

## Remaining Alpha Limits

- `qwen2.5-coder:7b` frequently ignores even a strict JSON-only contract. Bounded
  correction contains the failure but does not make the model reliable.
- Autonomous exploration can stop for model exhaustion, candidate exhaustion,
  approval, action budget, or null-decision exhaustion without satisfying a broad
  objective.
- Deterministic selectors reflect the current DOM. Highly dynamic pages can still
  invalidate them between observation and action; uncertain clicks are not replayed.
- A controlled stop is explainable and safe, but it is not equivalent to test-goal
  completion or finding a target-site bug.

The stability changes preserve the frozen Alpha architecture. They add no planner,
framework, cloud service, benchmark special case, or unbounded recovery behavior.

## Repository Verification

- `npm run build`: passed.
- `npm test`: 45 files and 344 tests passed.
- `npm run lint`: passed.
- `npm run format:check`: passed.
