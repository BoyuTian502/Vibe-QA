# Alpha Safety / Approval Acceptance

Date: 2026-08-31. Result: **PASS after a targeted safety-policy fix**, within the
existing [frozen Alpha boundary](ALPHA_ARCHITECTURE.md).

## Scope

The normal dashboard has no approval/resume UI. On a pending approval it records
the request, stops the run, and closes the browser. The existing TestTask /
AgentTestRequestExecutor `onApproval` callback can resume the same Agent and browser;
that capability was tested separately, not represented as a dashboard capability.
No UI, planner, Adaptive/Hybrid, Agent Core, or benchmark implementation changed.

All targets were isolated local servers. The destructive control came from the
existing HTML fixture in `apps/dashboard/tests/functional-form.test.ts`: its
"Delete account" button is inert, not a real account deletion endpoint. The
acceptance harness reused that HTML and added local event counters without changing
its controls. The settings continuation used the existing benchmark application.

## Defect Found And Fixed

Previously, the login exception examined the entire run goal and page text.
If the goal mentioned login, a later `button[type="submit"]` on `/settings` could
be allowed as an authentication step. The pre-fix authenticated continuation
actually sent one local settings write without requesting approval; its trace
recorded `allow` with the login-exception reason.

The exception now examines the requested control, not the goal, page URL, title,
or unrelated page copy. A risky control cannot use the login exception. Existing
generic `button[type="submit"]` login selectors remain compatible when the live
observation contains a single visible, enabled button identifying sign-in.
Ambiguous generic submits require approval. Existing block rules and decision
categories are unchanged.

The credential-echo test double now exposes its existing sign-in control in the
observation rather than relying on the old goal-wide exception.

## Measured Acceptance

The final local run completed from 08:15:13 to 08:15:23 UTC. Four runs were submitted
by Playwright through the real dashboard New Test form, `POST /tests`, the normal
request builder, default deterministic product executor, Agent, and Safety Policy.
No planner or approval handler was injected into these UI runs.

| Check | Decision / outcome | Measured effect |
| --- | --- | --- |
| Fill First Name, then Delete account | `block`; controlled failed test | Zero destructive clicks; trace retains requested click and block reason |
| Fill First Name, then Submit | `require_approval`, `pending`; controlled failed test | Zero submissions; request ID and pending status visible in trace/dashboard |
| Benchmark temporary login | Allowed; passed | Dashboard reached; six masked evidence screenshots |
| Authenticated negative assertion | Failed as deliberately expected | Missing-text assertion supplies real evidence to inspect the analysis input without exposing credentials |
| Authenticated settings, existing callback API | Pending, then approved once; passed | Zero settings writes before approval; one click and one write after approval |

For the callback case, the pending snapshot retained the original goal, current
settings observation, six prior actions, step count six, and approval request ID.
The browser stayed open during the approval wait. Approval resumed the original
action, with one browser launch, one close, an unchanged authentication cookie,
and nine action entries in one continuous trace. The same approval ID appeared on
the successful action. Temporary credentials were cleared on completion.

The new Playwright regression test additionally verifies denied and unhandled
approval: both produce zero settings clicks/writes and unchanged saved settings.
Existing Agent tests cover wrong request IDs, preserved pending state, denial,
and exactly-once resume. Existing form tests confirm a hard block never invokes
the approval handler, even when that handler would approve.

## Evidence And Redaction

Generated evidence remains local and gitignored under `run-output/demo/`:

| Check | Run directory |
| --- | --- |
| UI block | `2026-08-31T08-15-13-712Z-request-482a1071` |
| UI pending approval | `2026-08-31T08-15-15-927Z-request-f8cbdc86` |
| UI authenticated login | `2026-08-31T08-15-17-868Z-request-d2b32b4e` |
| UI authenticated negative assertion | `2026-08-31T08-15-19-531Z-request-8c8fb487` |
| API authenticated approval/resume | `2026-08-31T08-15-21-052Z-request-acceptan` |

Each directory contains the real `report.json`, `trace.json`, and screenshots.
The ignored acceptance summary and dashboard captures are in
`run-output/safety-acceptance/`. These files are not included in the commit.

- Report, trace, request/API responses, rendered report HTML, analysis input prompt,
  and analysis response were checked for the supplied benchmark credential values
  and session-cookie value. No matches were found in the final runs.
- All nine distinct images across 28 evidence screenshots were visually inspected
  after grouping identical files by hash. Username/password fields and matching
  owner text were masked. No supplied credentials were visible.
- The authenticated negative assertion intentionally used absent expected text;
  it is a redaction probe, not a newly discovered website bug.
- Analysis used the existing local baseline. The actual AI prompt construction
  boundary was checked, but no external model/provider was invoked or certified.
- All acceptance-owned browsers and servers closed, and local benchmark data was
  reset. Existing user dashboard processes were not interrupted.

## Limits Observed

- A pending dashboard report is a safe stopped run, not a resumable live browser.
  Interactive consent in the product remains deferred by the architecture freeze.
- The current report labels safety stops as failed tests / issues. Those are
  execution-policy outcomes, not evidence that the target application is defective;
  the trace gives the precise safety reason and approval status.
- An initial attempt to address "Save settings" through the normal Functional form
  builder was rejected as an ambiguous control before any safety decision. That
  form-locator limitation is outside this safety fix. The UI approval check used
  the existing Submit fixture; the benchmark settings check used the existing
  structured callback path with an explicit selector.
- This acceptance covers these observed local workflows, not arbitrary websites,
  semantic side-effect inference, or a hardened browser security sandbox.

## Verification

- `npm run build`: passed.
- `npm test`: 305 tests passed in 42 files, including nine added regression cases.
  Windows test workers were bounded with `VITEST_MAX_FORKS=2` and
  `VITEST_MIN_FORKS=1`; no test coverage was skipped.
- `npm run lint`: passed.
- `npm run format:check`: passed.

The fix is limited to the existing safety-policy implementation, focused tests,
one corrected test observation, and this acceptance record. No new policy category,
framework, or execution architecture was introduced.
