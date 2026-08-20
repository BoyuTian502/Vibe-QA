# Vibe-QA Technical Demo

## What problem Vibe-QA solves

Website teams need to know whether an important user journey still works after a
change. Manual testing is slow, and some failures, such as JavaScript crashes,
are easy to miss even when a page still looks normal. Vibe-QA operates a real
browser, checks the outcome of each action, and turns failures into
evidence-backed bug reports.

## How the agent works

The demo composes Vibe-QA's existing testing components into one local workflow:

1. Start the resettable benchmark website.
2. Open a visible Chromium browser through Playwright.
3. Follow a deterministic test plan so the presentation is repeatable.
4. Observe the page after every action and compare the result with expectations.
5. Capture page errors, screenshots, and the complete agent trace.
6. Produce a structured test result and BugReport, then close all resources.

The default scenario uses the existing `BUG-BENCH-005` benchmark defect. No paid
LLM service or API key is required. Password values are redacted from saved
reports and traces.

## Run the demo

From the repository root, install dependencies once and start the default bug
demo:

```bash
npm install
npm run demo:qa
```

Useful presentation options:

```bash
npm run demo:qa -- --scenario bug
npm run demo:qa -- --scenario login
npm run demo:qa -- --keep-open
```

The `bug` scenario is the default. The `login` scenario demonstrates a
successful journey. With `--keep-open`, the final browser state remains visible
until Enter is pressed.

## Presenter script

"Vibe-QA is testing a local sample product exactly as a user would. It signs in,
checks that the private dashboard opens, and tries a dashboard control. After
every step, it observes the real page and checks what changed. The control
triggers a seeded JavaScript crash. Vibe-QA catches that hidden browser error,
marks the test as failed, and saves the screenshot, structured report, and full
action history needed to reproduce it. The default demo is deterministic, so it
does not depend on a paid AI service during a presentation."

## Example output

```text
--------------------------------------------------
Vibe-QA Technical Demo
--------------------------------------------------
Watch Vibe-QA test a sample website in a real browser.

[1] Preparing the sample website...
    [OK] Sample website is ready

[2] Opening a browser you can watch...
    [OK] Browser opened

[3] Testing the website step by step...
    [OK] Open the sign-in page
    [OK] Enter the demo email address
    [OK] Enter the demo password securely
    [OK] Sign in
    [OK] Confirm the private dashboard opened
    [ISSUE] Click the fragile dashboard widget

[4] Reviewing what happened...
    [ISSUE] The page reported 1 JavaScript error(s)

--------------------------------------------------
WEBSITE TEST RESULT: ISSUE FOUND
--------------------------------------------------
```

Real evidence is written to `run-output/demo/<timestamp>/`. This directory is
gitignored and contains `report.json`, `trace.json`, and captured screenshots.
