# VibeQA Alpha-0 Development Plan

## General instruction to Codex

Read every file in `/docs` before implementation.

Do not expand scope without an explicit requirement.

Before making a large architectural change:

1. Explain the reason.
2. Identify which document conflicts with the change.
3. Propose the smallest correction.
4. Update the affected documentation.

## Milestone 0: Repository foundation

Create a TypeScript monorepo or simple workspace with:

```text
apps/
  benchmark-app/
  cli/
  worker/
packages/
  schemas/
  browser-tools/
  test-fixtures/
  prompts/
docs/
```

Required:

- TypeScript strict mode
- ESLint
- Prettier
- Vitest
- Zod
- Playwright
- LangGraph.js
- Environment validation
- Structured logger

Exit criteria:

- All packages compile.
- Unit-test command works.
- CLI prints help.
- Benchmark app runs locally.

## Milestone 1: Benchmark website

Build a simple authenticated project or todo application.

Required flows:

- Login
- View dashboard
- Create item
- Edit item
- Delete item
- Logout

Seed the ground-truth bugs defined in `MVP_SCOPE.md`.

Keep the implementation deterministic.

Add:

- Dedicated test account
- Known routes
- Bug manifest outside the agent-visible application
- Reset script for database and session state

Exit criteria:

- Every seeded bug can be manually reproduced.
- The app can be reset before each agent run.
- Ground-truth tests verify each seeded bug exists.

## Milestone 2: Browser worker

Implement:

- Browser context manager
- Storage-state loading
- Allowed-origin enforcement
- Element registry
- Page observer
- Console recorder
- Network recorder
- Screenshot capture
- Trace start and stop
- Typed browser commands
- Action JSONL logging
- Observation JSONL logging

Initial tool set:

- observe
- navigate
- click
- fill
- select
- refresh
- go_back
- assert
- reset

Exit criteria:

- A deterministic script can log in through storage state.
- It can create an item.
- It captures screenshot, console, network, and trace.
- It blocks navigation outside the allowed origin.
- It blocks a configured destructive element.

## Milestone 3: Schemas and state

Implement Zod schemas for:

- Run configuration
- WebsiteTestState
- PageState
- ElementDescriptor
- Observation
- TestMission
- ExpectedBehavior
- Hypothesis
- Experiment
- Anomaly
- BugInvestigation
- BugReport
- CoverageState

Exit criteria:

- Every persisted object validates.
- Invalid LLM output is rejected.
- State can be saved and restored.

## Milestone 4: Deterministic experiment engine

Implement experiment templates:

1. Valid create
2. Empty create
3. Whitespace-only create
4. Long-text create
5. Create-refresh-verify
6. Logout-revisit-protected-route
7. Duplicate submit

Implement the test-data factory.

Exit criteria:

- Each experiment can run without an LLM when supplied with correct element IDs.
- Each experiment has preconditions and assertions.
- Each experiment can restore its precondition checkpoint.

## Milestone 5: Initial LangGraph workflow

Implement nodes:

- initialize_run
- validate_policy
- prepare_browser
- authenticate
- initial_observation
- update_website_model
- generate_missions
- generate_hypotheses
- select_experiment
- execute_experiment
- collect_observation
- detect_anomalies
- investigate_bug
- update_coverage_and_model
- evaluate_stop_conditions
- generate_report

Initially, use deterministic stubs for the semantic LLM nodes.

Exit criteria:

- The graph can complete a full run.
- State persists between nodes.
- The graph loops through multiple experiments.
- It stops under budget limits.
- It produces a valid empty or non-empty report.

## Milestone 6: LLM semantic nodes

Add LLM calls only for:

- Page-purpose understanding
- Feature inference
- Mission generation
- Hypothesis generation
- Ambiguous anomaly judgment
- Report wording

Requirements:

- Structured output only
- Zod validation
- Retry at most once for schema repair
- Compact prompt context
- No secrets
- No complete raw DOM
- Record prompt version and model metadata

Exit criteria:

- The agent identifies the create-item feature.
- It generates a persistence hypothesis.
- It selects a safe high-value experiment.
- It remains within the LLM-call budget.

## Milestone 7: Anomaly detection and investigation

Implement deterministic rules for:

- Uncaught exception
- HTTP 500–599
- Failed mutation
- Blank page
- Infinite loading
- Missing entity after successful create
- Private state accessible after logout

Implement reproduction:

- Restore checkpoint
- Re-run exact steps
- Compare evidence
- Calculate confidence
- Classify result

Exit criteria:

- Persistence bug is confirmed.
- HTTP 500 is confirmed.
- Normal loading is rejected as a bug.
- A non-reproducible anomaly is marked flaky or rejected.

## Milestone 8: Reporting

Produce:

- `report.json`
- `report.md`
- `bugs.json`
- `actions.jsonl`
- `observations.jsonl`
- screenshots
- trace

Each bug must include:

- Severity
- Confidence
- Steps
- Expected behavior
- Actual behavior
- Evidence references
- Cursor-ready fix prompt

Exit criteria:

- Output files validate.
- Report remains usable when there are zero bugs.
- Trace and screenshot paths are correct.

## Milestone 9: Evaluation harness

Run the agent repeatedly against a reset benchmark app.

Track:

- Critical-flow completion rate
- Bug recall
- Bug precision
- Actions per confirmed bug
- LLM calls per run
- Runtime
- Flaky-run rate
- Safety violations

Create a summary command:

```bash
npm run evaluate -- --runs 10
```

Exit criteria:

- Benchmark results are reproducible.
- Metrics are written to JSON and Markdown.
- The evaluation identifies regressions in the agent.

## Codex first instruction

Use this prompt after importing the repository:

```text
You are the lead engineer for VibeQA.

Read README.md and every file in /docs.

Do not implement the full product yet.

First:
1. Summarize the final Alpha-0 scope.
2. Identify contradictions or missing implementation decisions.
3. Propose the exact repository structure.
4. Propose the first five commits.
5. State which milestone you will implement first and why.

Do not write code until this analysis is complete.
```

## Recommended first five commits

1. `chore: initialize strict TypeScript workspace`
2. `feat: add benchmark app with resettable seeded bugs`
3. `feat: implement typed Playwright browser worker`
4. `feat: add agent state schemas and run persistence`
5. `feat: add deterministic experiment loop and reporting`
