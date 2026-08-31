# VibeQA Architecture

> Historical design proposal. For the implemented v0.1.0-alpha execution freeze,
> see [Alpha Architecture](ALPHA_ARCHITECTURE.md). In particular, LangGraph below
> is deferred and is not a dependency of the current execution architecture.

## 1. Architectural principle

VibeQA should not be implemented as a group of loosely coordinated conversational agents.

The Alpha-0 architecture is:

```text
One stateful LangGraph workflow
+ one isolated Playwright browser worker
+ deterministic safety and observation layers
+ LLM calls only at semantic decision points
```

This reduces cost, state drift, and unpredictable communication between agents.

## 2. High-level architecture

```text
┌─────────────────────────────────────────────┐
│ User or CLI                                 │
│ URL / description / auth / goals / rules    │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ Test Orchestrator: LangGraph.js             │
│                                             │
│ initialize                                  │
│ authenticate                                │
│ observe                                     │
│ understand                                  │
│ generate missions                           │
│ generate hypotheses                         │
│ select experiment                           │
│ execute                                     │
│ detect anomaly                              │
│ investigate                                 │
│ update coverage                             │
│ stop or continue                            │
│ report                                      │
└───────────────────┬─────────────────────────┘
                    │ typed commands
                    ▼
┌─────────────────────────────────────────────┐
│ Playwright Browser Worker                   │
│                                             │
│ browser lifecycle                           │
│ page observation                            │
│ element registry                            │
│ navigation                                  │
│ click / fill / select / upload              │
│ console capture                             │
│ network capture                             │
│ screenshots                                 │
│ video and trace                             │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
              Target website
```

## 3. Recommended Alpha-0 stack

```text
Language:          TypeScript
Runtime:           Node.js
Browser:           Playwright
Agent orchestration: LangGraph.js
Validation:        Zod
CLI:               Commander or equivalent
Persistence:       SQLite first, PostgreSQL later
Queue:             None for local Alpha-0; BullMQ later
Storage:           Local run-output first; S3 later
Frontend:          None required for Alpha-0
```

A single TypeScript runtime is preferred for Alpha-0.

Do not add Python until a future image-analysis or machine-learning service requires it.

## 4. Core modules

### 4.1 CLI

Responsible for:

- Parsing user arguments
- Validating URL and mode
- Loading the project configuration
- Starting a test run
- Printing progress
- Returning a process exit status

### 4.2 Test Orchestrator

Responsible for:

- Holding persistent test state
- Routing between workflow nodes
- Enforcing the run budget
- Managing checkpoints
- Pausing for manual authentication or approval
- Generating the final report

### 4.3 Browser Worker

Responsible for all browser interaction.

The LLM must never execute arbitrary Playwright code.

The worker only accepts typed, allow-listed commands.

### 4.4 Observation Collector

Collects a normalized observation after each meaningful action:

- URL
- Page title
- Visible headings
- Dialogs and alerts
- Interactive elements
- DOM-change indicators
- Console errors
- Failed and server-error network requests
- Screenshot reference
- Trace reference
- Loading duration
- New entity detection

### 4.5 Website Model

Stores the system’s current understanding of:

- Page states
- Features
- Business entities
- Candidate workflows
- Transitions
- Expected behaviors
- Tested and untested actions

### 4.6 Experiment Library

Provides deterministic templates such as:

- Create valid entity
- Submit empty form
- Submit whitespace-only value
- Submit long value
- Save, refresh, and verify
- Edit and verify
- Logout and revisit protected route
- Repeat submit
- Browser back and forward
- Deep-link navigation

### 4.7 Anomaly Detector

Uses deterministic rules first.

LLM evaluation is only used for ambiguous semantic failures.

### 4.8 Bug Investigator

Restores a checkpoint and reproduces the exact sequence.

It decides whether to classify the event as:

- Confirmed
- Likely
- Needs Review
- Rejected
- Flaky

### 4.9 Report Generator

Produces:

- Machine-readable JSON
- Developer-friendly HTML or Markdown
- Cursor-ready fix prompt

## 5. Data flow

```text
User input
→ validated run configuration
→ browser context
→ initial observation
→ page-state model
→ mission and hypothesis queue
→ selected experiment
→ typed browser actions
→ observations and evidence
→ anomaly candidates
→ reproduction attempt
→ confirmed bug store
→ coverage update
→ stop decision
→ report
```

## 6. Evidence storage strategy

Large artifacts must not be embedded in LangGraph state.

Store references instead.

```text
State:
- screenshot_ref
- trace_ref
- video_ref
- observation_id
- network_event_ids

Artifact storage:
- PNG screenshots
- ZIP traces
- WebM video
- JSONL action and observation logs
```

## 7. Page-state identity

A page state is not equal to a URL.

Single-page applications may keep the same URL while changing:

- Active tab
- Modal state
- Drawer state
- Loaded entity
- Form mode
- Authentication status

Generate a stable page-state fingerprint from:

- Normalized URL
- Title
- Visible headings
- Landmarks
- Open dialogs
- Key entity identifiers

Exclude timestamps, random classes, request IDs, and animation state.

## 8. Locator strategy

The element registry should prefer:

1. Role and accessible name
2. Associated label
3. Placeholder
4. Test ID
5. Stable visible text
6. Stable CSS fallback

The LLM receives opaque element IDs and semantic metadata.

It does not receive permission to invent arbitrary selectors.

## 9. Authentication architecture

### Credential flow

The browser worker receives a secret reference.

It resolves the secret directly and fills the form.

The LLM only knows that credentials are available.

### Manual session flow

```text
Start browser
→ pause graph
→ user completes login
→ save Playwright storage state
→ resume graph
```

The authentication-state file must be treated as a secret.

## 10. Safety architecture

The safety gate runs before every browser action.

It checks:

- Allowed origin
- Action category
- Element text
- Destructive-risk tags
- User restrictions
- Upload fixture
- Approval requirement

Possible outcomes:

```text
allow
block
require_approval
```

## 11. Reliability strategy

- Use short experiments instead of long free-form paths.
- Restore a checkpoint before bug reproduction.
- Cap retries.
- Detect state saturation.
- Prefer deterministic assertions.
- Keep LLM output structured and schema validated.
- Record all actions and observations as append-only JSONL.
- Use seeded benchmark bugs to measure regressions in the testing agent.
