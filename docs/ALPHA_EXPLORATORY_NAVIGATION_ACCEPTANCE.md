# Exploratory Navigation Acceptance

Date: 2026-08-31. Scope: the final redirect/404 compatibility fix before Alpha
release review. No release/tag, new planner, benchmark experiment, or Agent/Adaptive
redesign is included.

## Root Causes

1. The shared Agent evaluator compared requested and final URLs exactly (apart
   from a trailing slash). A successful redirected navigation could therefore
   stop exploration with an Agent error. BrowserSession discarded navigation
   response information, so verification had no supporting redirect evidence.
2. Product exploratory reporting checked actions, assertions, and console errors,
   but not top-level HTTP status or a clear rendered not-found page. Resource-load
   console messages are intentionally filtered, and a client-side 404 may return
   HTTP 200 without any console exception.

## Scoped Behavior

- Browser observations now optionally include requested URL, final URL, completion,
  redirect flag, current top-level document status, and the HTTP request chain.
  API, image, and iframe errors do not overwrite document status. A different SPA
  route does not inherit the previous document's HTTP status.
- The product Exploratory Agent receives an `ExplorationEvaluator` through its
  existing evaluator option. The shared evaluator and Functional/Regression
  expectations remain unchanged.
- A changed destination passes navigation verification only with matching,
  completed navigation evidence and an observable, non-error page. Same-origin
  HTTP(S) redirects and a same-host standard HTTP-to-HTTPS upgrade are accepted.
  Cross-origin hops, embedded URL credentials, unsafe schemes, stale/missing
  evidence, and unobservable destinations are not silently accepted.
- A browser navigation exception still fails. Successfully reaching a page is not
  proof that an explicit expected text/state assertion has passed.
- Main-document HTTP 404 and 500-599 responses create page findings. Other status
  codes are not automatically classified as bugs. HTTP 200/unknown status can use
  a conservative title or visible H1 label such as `404`, `Page not found`, or
  `404: This page could not be found.` Ordinary body mentions, hidden headings,
  and explanatory headings such as `How to handle 404 responses` do not qualify.
- A page finding stores its observed status (200 stays 200 for a soft 404), URL,
  title, signal source, screenshot, leading action/path, and existing severity
  convention: medium without console errors, high with console errors.
- Exploration stops after the finding with `page-error`. Initial error pages are
  recorded before asking a planner for an action. Trace and report evidence are
  preserved; the dashboard shows `Issue found`, not an Agent/model error.

No LLM judge, status-code monitoring service, or new framework was added. The
existing same-origin action guard, approval policy, credential redaction, readiness
wait, screenshot collection, and Adaptive V2 routing remain active.

## Live QA Practice Revalidation

Two distinct checks are reported, without substituting the deterministic result
for the autonomous result.

### Original Autonomous Objective

The unchanged New Test objective requested first-time autonomous exploration,
safe navigation/interactions, visible failures, and screenshot evidence. Target:
`https://www.qapractice.com/`. Mode: Exploratory. Expected text: empty.

- Run: `2026-08-31T09-38-59-985Z-request-8484e080`.
- Strategy: Adaptive V2; real local `qwen2.5-coder:7b` at IPv4 loopback.
- 7 model calls, 3 executed navigations, 4 page states, 7 screenshots, 79,458ms.
- Visited homepage, `/practice-page-selection`, `/AboutPage`, and `/interview`.
- 3 invalid element selections recovered using the existing bounded mechanism.
- Ended with `MODEL_ERROR` / `agent-error`: invalid BrowserAction JSON.
- No page-error findings: this run did not visit either recorded problem path.

This is not claimed as a successful autonomous run or as evidence that the two
defects were covered. The model-quality limitation remains unchanged.

### Recorded-Destination Product Replay

The same UI/backend, Adaptive V2 adapter, safety checks, readiness handling, and
real Playwright browser were exercised with two scripted client decisions targeting
the previously observed URLs. This is a controlled reproduction, not an AI planning
success and not another benchmark. HTTP/page responses were live, not mocked.

- Run: `2026-08-31T09-42-50-184Z-request-3b2ea252`.
- 2 scripted client responses; **zero real model calls**. The existing controller's
  invocation counter is 2 because it counts calls through its injected client.
- 2 executed navigations, 3 states, 3 screenshots, 8,412ms.
- Both actions recorded safety `allow`.

| Requested destination | Observed final destination | Verification |
| --- | --- | --- |
| `/interview-preparation` | `/interview` | Redirect accepted after the page became observable |
| `/PracticePage` | `/PracticePage` | Page-not-found finding; observed HTTP 200 |

The interview redirect is a client-side route transition. Its final-route HTTP
status is unknown (`null`), not a fabricated 200. The HTTP request chain contains
the original document request; requested/final URL fields separately record the
client-side redirect. The resulting interview page was observable and error-free.

The not-found page had title `Page Not Found (404) | QA Practice` and a prominent
404/page-not-found heading. One medium-severity finding was created with screenshot
and both preceding navigation actions. Final outcome: **TARGET_ISSUE**, termination
**page-error**. The rendered report, timeline, local analysis, and screenshots were
checked. This captures a reached error page; human review of the chosen path is
still needed before asserting that the website itself has a broken link.

An earlier direct browser probe observed the interview route while still empty
after a fixed one-second wait. It correctly failed verification for lack of an
observable page. That preliminary probe is not the acceptance result; the product
replay above used the existing bounded readiness handling and passed.

## Local Tests And Evidence

Focused tests cover direct/redirect navigation, unsafe/unverified redirects,
main-document HTTP 404/5xx, blank rendered error documents, client-side not-found
labels, false positives, stale SPA statuses, subresources, real navigation failure,
trace/report/UI findings, screenshots, and credential redaction in the new metadata.
Existing tests cover Functional/Regression routing, authentication, approvals,
Agent behavior, and Adaptive/Hybrid compatibility.

Local evidence (gitignored):

- `run-output/alpha-navigation/summary.json`: autonomous run and preliminary probes.
- `run-output/demo/2026-08-31T09-38-59-985Z-request-8484e080/`: autonomous artifacts.
- `run-output/alpha-navigation/recorded-path-summary.json`: accepted live replay.
- `run-output/alpha-navigation/recorded-path/2026-08-31T09-42-50-184Z-request-3b2ea252/`:
  accepted replay report, trace, and screenshots.
- `run-output/alpha-navigation/recorded-path-result.png`: inspected result view.

All revalidation-owned browsers and temporary dashboard servers closed. No
credentials were supplied to the external site. No generated artifacts are committed.

## Remaining Limits

The deterministic fallback intentionally recognizes only clear error-page labels;
it is not semantic error detection. Cross-origin redirects require review rather
than automatic acceptance. A non-renderable response/navigation exception remains
a browser error. A captured not-found page can be caused by a model-selected bad
URL and does not by itself prove a website implementation defect. Local-model
invalid JSON/target/early-stop limitations remain outside this fix.

## Final Verification

- `npm run build`: passed.
- `npm test`: 333 tests passed across 44 files (16 focused tests added).
- `npm run lint`: passed.
- `npm run format:check`: passed.

The full suite ran with two maximum Vitest forks to bound local memory; no test
files were excluded. No large benchmark was run. New tests initially exposed a
fixture mistake (a zero-byte HTTP error response is not an observable HTML page in
Chromium); the fixture was corrected to a valid empty-body HTML document without
swallowing real browser navigation errors.

The next step is final release review, not another Exploratory milestone.
