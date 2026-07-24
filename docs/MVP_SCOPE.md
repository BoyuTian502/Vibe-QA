# VibeQA Alpha-0 Scope

## 1. Objective

Build the smallest working prototype that proves VibeQA can:

1. Load an authenticated website.
2. Understand a simple application page.
3. Select and execute safe test experiments.
4. Detect known functional failures.
5. Reproduce suspected bugs.
6. Produce evidence-backed reports.

## 2. Alpha-0 interface

Alpha-0 is a local CLI.

Example:

```bash
npm run vibeqa -- \
  --url http://localhost:3000 \
  --description "A simple project management app" \
  --mode exploration \
  --storage-state .auth/test-user.json \
  --max-actions 40
```

## 3. Included capabilities

### Browser

- Chromium
- Open URL
- Load storage state
- Observe page
- Click
- Fill
- Select
- Refresh
- Go back
- Screenshot
- Trace
- Console-event capture
- Network-event capture

### Testing

- Happy-path creation flow
- Empty-field validation
- Whitespace-only validation
- Long-text validation
- Save and refresh
- Logout and protected-route revisit
- Duplicate-submit check
- Broken navigation check

### Agent

- Page understanding
- Mission generation
- Hypothesis generation
- Experiment scoring
- Bounded test loop
- Anomaly queue
- Bug reproduction
- Stop conditions

### Output

- report.json
- report.md or report.html
- bugs.json
- actions.jsonl
- observations.jsonl
- trace.zip
- screenshots

## 4. Explicit exclusions

Do not implement:

- Full SaaS frontend
- User registration
- Billing
- Cloud browser fleet
- Redis
- BullMQ
- S3
- PostgreSQL
- Multi-user accounts
- Multi-browser testing
- Mobile emulation
- Visual-diff engine
- Accessibility audit
- Performance audit
- Security attack payloads
- CAPTCHA bypass
- Automatic source-code repair
- Jira or Slack integration
- CI/CD integration
- Browser-use frameworks outside Playwright
- Unbounded autonomous browsing

## 5. Benchmark application

Build a controlled project-management or todo application.

Required features:

- Login
- Dashboard
- Create item
- Edit item
- Delete item
- Logout

Seeded bugs:

### BUG-BENCH-001: Persistence

A newly created item appears immediately but disappears after refresh.

### BUG-BENCH-002: Authentication

After logout, navigating directly to the dashboard still exposes private content.

### BUG-BENCH-003: Validation

Whitespace-only item names are accepted.

### BUG-BENCH-004: Server error

A designated valid action triggers HTTP 500.

### BUG-BENCH-005: Client exception

A specific interaction triggers an uncaught JavaScript exception.

Optional:

### BUG-BENCH-006: Long text

Very long input breaks a critical card layout.

## 6. Ground-truth file

The benchmark app must include a machine-readable bug manifest that is not visible to the testing agent.

```json
{
  "application": "benchmark-project-manager",
  "bugs": [
    {
      "id": "BUG-BENCH-001",
      "type": "persistence",
      "severity": "high",
      "description": "Created projects disappear after refresh."
    }
  ]
}
```

## 7. Alpha-0 acceptance criteria

The prototype passes when:

- It completes the critical happy path in 9 of 10 runs.
- It finds BUG-BENCH-001 in at least 8 of 10 runs.
- It finds deterministic 500 errors in at least 9 of 10 runs.
- It captures uncaught console exceptions.
- It never performs an explicitly forbidden destructive action.
- Every confirmed bug includes steps and at least one evidence artifact.
- It does not report ordinary loading under the timeout threshold as a bug.
- It stops when the action budget is reached.
- It recovers from one failed selector or stale element.
- It generates a valid final report even when no bugs are found.
