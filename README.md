# VibeQA

VibeQA is an autonomous AI QA agent for websites built by indie developers, small teams, and vibe-coding users.

A user provides:

- A website URL
- A short description of the product
- A test account or authenticated browser session
- Optional critical user flows
- Safety restrictions

VibeQA then:

1. Opens the website in an isolated Chromium browser.
2. Authenticates when required.
3. Understands the visible product structure.
4. Executes core functional and regression checks.
5. Performs bounded exploratory testing.
6. Captures console, network, screenshot, video, and trace evidence.
7. Reproduces suspected failures.
8. Produces developer-oriented bug reports and fix prompts.

## Product principle

VibeQA is not primarily a test-code generator.

It is a stateful website-testing agent that forms hypotheses, runs controlled experiments, validates failures, and reports evidence.

## Current phase

The project is in the Alpha-0 prototype phase.

Do not build a full SaaS product yet. The immediate goal is to prove that the agent can reliably test one controlled benchmark website and detect known functional bugs.

## Repository structure

```text
vibeqa/
├── apps/
│   ├── benchmark-app/
│   ├── cli/
│   └── worker/
├── packages/
│   ├── schemas/
│   ├── prompts/
│   ├── browser-tools/
│   └── test-fixtures/
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── AGENT_DESIGN.md
│   ├── MVP_SCOPE.md
│   └── DEVELOPMENT_PLAN.md
└── README.md
```

## Alpha-0 command

The intended prototype interface is:

```bash
npm run vibeqa -- \
  --url http://localhost:3000 \
  --description "A project management application" \
  --mode exploration \
  --storage-state .auth/test-user.json \
  --max-actions 40
```

Expected output:

```text
run-output/
├── report.json
├── report.html
├── bugs.json
├── actions.jsonl
├── observations.jsonl
├── trace.zip
└── screenshots/
```

## Engineering rules

- Use TypeScript across the Alpha-0 stack.
- Use Playwright for browser control.
- Use LangGraph.js for orchestration and persistent state.
- Use Zod for every LLM and tool boundary.
- Never allow the LLM to execute arbitrary browser code.
- Browser actions must use an allow-listed typed tool interface.
- Never expose passwords or authentication tokens to the LLM.
- Every confirmed bug must include reproducible evidence.
- Safety policy enforcement must be deterministic, not prompt-only.
- Keep the first implementation narrow and measurable.
