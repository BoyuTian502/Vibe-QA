# Evaluation Reference

Historical benchmark commands and measured comparisons, retained from the Alpha README.
These are maintainer tools, not normal product mode controls. No new experiment was
run for release polish. See [the product guide](../README.md).

The following research and debug capabilities are retained for maintainers.
They are not normal product configuration and do not change the Alpha mode policy.

<details>
<summary>Benchmark strategies, historical comparisons, and diagnostics</summary>

### Evaluation Benchmark V2

Individual test reports show what happened in one run. The evaluation benchmark
repeats a representative suite against the seeded benchmark application to
measure how reliably Vibe-QA completes expected workflows and detects known
website defects.

Run the deterministic baseline with five repetitions per scenario:

```bash
npm run benchmark:qa
```

Change the repetition count or select a smaller slice:

```bash
npm run benchmark:qa -- --runs 10
npm run benchmark:qa -- --scenario bug-widget-crash
npm run benchmark:qa -- --mode exploratory
```

The report includes task success rate, seeded bug detection rate, false positive
rate, repeated-run stability, safety events, mode-level performance, and
descriptive statistics for step count and execution duration. A website test can
have status `failed` because it exposed a defect while the benchmark result is
`EXPECTED_BUG_FOUND`, which counts as a successful evaluation outcome.

The baseline suite covers successful and rejected authentication, authenticated
dashboard access, project and settings navigation, post-logout route protection,
the seeded fragile-widget defect, and deterministic exploratory coverage.

Each repetition resets the benchmark data and launches a fresh isolated browser
context. The default suite uses deterministic scenarios and requires no external
LLM or paid API. Compact `summary.json`, `runs.json`, and `benchmark-report.md`
artifacts are written to `run-output/benchmark/<timestamp>/`; credentials, raw
traces, and screenshots are not included.

## Generalization Benchmark V3

V3 asks a different question: what value does a planner add when the exact
browser path and bug location are not provided? It runs blind hidden-bug hunts,
ambiguous account and project goals, same-URL dashboard state changes, and
recovery scenarios with realistic safe distractors.

```bash
npm run benchmark:qa -- --suite generalization --planner deterministic --runs 2
npm run benchmark:qa -- --suite generalization --planner ollama --runs 2
npm run benchmark:qa -- --suite generalization --compare deterministic,ollama --runs 3
npm run benchmark:qa -- --suite generalization --compare deterministic,ollama --runs 10
```

The deterministic V3 baseline uses the existing Explorer candidate scoring. It
does not receive a hidden scripted path. Ollama uses the existing Agent and
`LLMClient` loop to select actions from live observations. Both planners receive
only the public goal, start URL, and step budget. Seeded bug IDs, evaluator
selectors, expected action sequences, credentials, and internal benchmark
metadata remain evaluator-only.

V3 reports autonomous discovery, ambiguous-goal completion, useful new states
per action, detours, state revisits, recovery, time to discovery, coverage before
discovery, and success within 5, 10, and maximum steps. Reports include 95%
Wilson confidence intervals for proportion metrics and planner-by-scenario
attempts, successes, step distributions, duration, stability, recovery,
coverage, detours, and revisits. Sample size, model, suite version, and Git
commit are shown beside the results. Metric-derived interpretation calls out
mixed scenario evidence instead of turning one result into a category-wide
claim.

Execution duration includes browser startup, authentication, browser work,
safety checks, and model calls, but excludes browser shutdown and report
writing. For Ollama runs, V3 also records elapsed `LLMClient.generate` wall time
so local planner latency can be separated approximately from the rest of the
workflow. This is request/inference wall time, not pure model compute time.

V3 results remain separate from V2 controlled-workflow reliability so the two
success rates are not conflated. Artifacts use the same
`run-output/benchmark/<timestamp>/` location and include
`suite: "generalization-v3"` metadata.

## Benchmark Comparison

The deterministic strategy is the default reproducible baseline. In V2, an
optional Ollama strategy uses the existing `LLMClient` abstraction and
`qwen2.5-coder:7b` to order known safe scenario steps. In V3, the same local
model selects browser actions autonomously from the public goal and current
observation. Typed credential values are inserted only during local setup and
are not sent to the model. Ollama must be running locally with the model
installed; Vibe-QA reports a clear error instead of silently falling back when
it is unavailable.

The default Ollama endpoint uses the IPv4 loopback address to avoid Windows and
Node resolving `localhost` to an unsupported IPv6 listener. Override it when
Ollama is hosted elsewhere:

```ini
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

```bash
npm run benchmark:qa -- --planner deterministic --runs 10
npm run benchmark:qa -- --planner ollama --runs 5
npm run benchmark:qa -- --difficulty hard --runs 10
npm run benchmark:qa -- --planner ollama --mode exploratory --runs 5
npm run benchmark:qa -- --compare deterministic,ollama --runs 5
```

## Hybrid Planner V2

Hybrid is an explainable task router over the existing deterministic and Ollama
strategies. It remains a small deterministic rules engine, not another LLM
router, and it does not receive benchmark IDs, hidden selectors, evaluator
recommendations, credentials, or secrets.

Hybrid V1 preserved controlled-workflow latency, averaging about 1.14 seconds
versus 1.02 seconds for deterministic and 2.22 seconds for Ollama. Its latest
generalization results were weaker: 15.0% hidden discovery, 37.5% ambiguous-goal
completion, 38.3% recovery, and 30.0% expected-outcome stability. Evaluator-side
routing diagnostics identified the deterministic defaults for ambiguous goals
and same-URL state reasoning as evidence-sensitive weaknesses.

Hybrid V2 uses this explicit precedence:

1. Regression and known functional workflows with clear expectations use
   deterministic execution.
2. Hidden-issue discovery and explicit exploration use Ollama.
3. Recovery without a known path and same-URL semantic state reasoning use
   Ollama.
4. Ambiguous semantic goals without an explicit workflow use Ollama.
5. Unknown cases retain the deterministic fallback.

Each decision records its rule, explanation, and deterministic confidence level
(`high`, `medium`, or `low`). Low-confidence routes still execute the selected
planner; Hybrid does not invoke another router, run both planners, or silently
change strategies.

```bash
npm run benchmark:qa -- --planner hybrid --runs 3
npm run benchmark:qa -- --suite generalization --planner hybrid --runs 3
npm run benchmark:qa -- --suite generalization --compare deterministic,ollama,hybrid --runs 3
```

The benchmark default remains deterministic. Benchmark Hybrid mode does not
silently fall back when Ollama is unavailable: the selected planner, executed
planner, routing rule, reason, availability failure, and fallback status remain
visible in run metadata. This prevents a deterministic fallback from being
counted as an Ollama execution.

Reports preserve the existing V4 section and add **Benchmark V4.1 - Hybrid
Routing Refinement**. Diagnostics include routing distribution, a confusion
matrix, agreement by scenario and category, rule and confidence performance,
historical alternative-planner comparisons, and routing-regret estimates. A
route has material estimated regret when the alternative planner's measured
success on the same scenario is at least 20 percentage points higher. Agreement
and regret are evaluator-side diagnostic proxies, not proof of causal
optimality, and evaluator recommendations are attached only after execution.
V2 controlled and V3 generalization metrics remain backward compatible.

The latest V2 robustness snapshot used 180 executions, with 60 per planner.
Hybrid V2 improved over the persisted V1 baseline on hidden discovery (20.0%
versus 15.0%), ambiguous goals (77.5% versus 37.5%), recovery (61.1% versus
38.3%), exploration efficiency (0.521 versus 0.454), state revisits (33.7%
versus 44.7%), and expected-outcome stability (58.3% versus 30.0%). However,
all current generalization scenarios matched Ollama-oriented rules, so Hybrid
averaged 7.14 seconds versus 6.20 seconds for pure Ollama and 1.20 seconds for
deterministic. Controlled Hybrid remained near deterministic at 1.16 seconds
versus 1.04 seconds. The result supports V2's quality improvement but not a
generalization-latency or routing-regret improvement; local model variability
and the current scenario mix remain important limitations.

## Adaptive Execution

Hybrid V2 makes one routing decision before execution. Its measured quality
improved, but static routing sent every current generalization scenario to
Ollama and therefore did not improve generalization latency. Adaptive Execution
V1 instead starts every task with the deterministic strategy and monitors only
runtime-observable evidence: repeated page states, no-progress windows, failed
actions or evaluations, stalled recovery, exhausted safe candidates, and the
deterministic step budget.

The balanced product defaults allow at most one transition from deterministic
to Ollama: four deterministic steps, two visits to an equivalent state, two
failed actions, or three no-progress observations can trigger escalation. The
same Agent and browser session continue after escalation, preserving the current
page, authentication, action history, Memory, Trace, Safety Policy state, and
step budget. Scenario IDs, benchmark labels, seeded bug IDs, hidden selectors,
evaluator recommendations, credentials, and secrets never participate in the
decision.

```bash
npm run benchmark:qa -- --planner adaptive --runs 3
npm run benchmark:qa -- --suite generalization --planner adaptive --runs 3
npm run benchmark:qa -- --suite generalization --compare deterministic,ollama,hybrid,adaptive --runs 3
```

Ollama availability is checked lazily only when escalation is required. If it
is unavailable, the run remains labeled Adaptive, records degraded execution
and the failed escalation, and is never counted as an Ollama execution. V5
reports include escalation and avoided-LLM rates, successful escalation,
pre/post escalation steps and time, invocation count, escalation utility, and
conservative/balanced/aggressive threshold projections. Those projections are
evaluator-side analysis only; they do not silently change product defaults.

Adaptive V1 is deliberately conservative and one-way. It does not use an LLM
router, restart the task, or cycle between planners. Its effectiveness must be
judged from measured controlled and generalization comparisons; escalation can
still be late, unnecessary, or unable to recover within the remaining step
budget.

### Adaptive V2 Opportunity Preservation

Adaptive V2 is the default Adaptive policy. It keeps V1's deterministic
progress monitoring as a fallback, but can hand control to Ollama before a
proposed deterministic action is executed. A deterministic, runtime-only
opportunity evaluator considers the public goal, visible enabled controls,
unexplored safe candidates, distinct navigation destinations, control
diversity, page regions, action history, and the proposed action. It never
receives scenario IDs, evaluator recommendations, hidden selectors, or bug
metadata.

Policy precedence is explicit:

1. Known scripted workflows remain deterministic.
2. Discovery or semantic goals on a high-branching state hand off before a
   narrowing action.
3. Existing recovery and semantic uncertainty signals remain eligible for
   escalation.
4. Repeated true stagnation remains the fallback.
5. Otherwise deterministic execution continues.

Ollama receives a compact continuation containing the sanitized public goal,
current visible state, up to five meaningful prior actions, remaining safe
candidates, progress summary, and handoff reason. Typed values, credentials,
bug IDs, hidden controls, and evaluator-only classifications are excluded.

A planner `null` is no longer treated as semantic completion by itself. When a
deterministic completion check cannot confirm the public goal and safe
unexplored candidates remain, V2 requests one bounded replan. The run still
terminates deterministically on confirmed completion, candidate exhaustion,
remaining-budget exhaustion, generation failure, or retry-limit exhaustion.

Use the policy switch for controlled A/B diagnostics:

```bash
npm run benchmark:qa -- --suite generalization --planner adaptive --adaptive-policy v1 --runs 3
npm run benchmark:qa -- --suite generalization --planner adaptive --adaptive-policy v2 --runs 3
npm run benchmark:qa -- --suite generalization --compare deterministic,ollama,hybrid,adaptive --adaptive-policy v2 --runs 10
```

V5 reporting remains available and now includes V2 early/stagnation escalation,
opportunity retained at handoff, safe candidates, planner-null and null-recovery
rates, completion-gate rejections, post-handoff utilization, hidden discovery
by handoff timing, and handoff-state similarity.

### Adaptive Failure Diagnostics

Generalization reports include an evaluator-only **Adaptive Escalation Failure
Analysis**. Each Adaptive run is split into deterministic, handoff, and Ollama
phases and records sanitized state summaries, remaining budget, planner output
classification, termination reason, repeated-state trigger quality, and
opportunity loss. The report also compares pure Ollama with escalated Ollama
when both planners are included in the same benchmark session. Hidden bug IDs,
hidden selectors, credentials, and raw prompts are never added to the handoff
snapshot.

Diagnostic replay can cap post-escalation actions without changing production
Adaptive defaults:

```bash
npm run benchmark:qa -- --suite generalization --planner adaptive --runs 3 --adaptive-debug-replay --post-escalation-steps 1
npm run benchmark:qa -- --suite generalization --planner adaptive --runs 3 --adaptive-debug-replay --post-escalation-steps 3
npm run benchmark:qa -- --suite generalization --planner adaptive --runs 3 --adaptive-debug-replay --post-escalation-steps 6
```

Replay mode reruns the deterministic local benchmark to the same handoff state
inside an isolated browser session and varies only the diagnostic
post-escalation cap. It is a debugging aid, not a production policy change.

Scenarios are labeled by meaningful execution demands:

- `easy`: short direct workflows with obvious controls.
- `medium`: multi-step state transitions, validation, navigation, or seeded bug
  verification.
- `hard`: exploratory discovery with broader candidate and page-state coverage.

Reports group task success, bug detection, false positives, infrastructure
errors, steps, duration, and repeated-run stability by planner, mode,
difficulty, and scenario. Exploratory groups also include page states,
interactive elements, candidate actions, and normalized coverage. Duration and
step distributions include count, mean, median, minimum, maximum, and standard
deviation. Same-session multi-planner runs additionally create
`comparison.json`; a comparison column is never emitted for a strategy that was
not executed.

The generated Markdown report includes configuration and Git revision metadata
alongside explicit limitations. It is a controlled-site evaluation, not a claim
of universal website-testing accuracy, and Ollama results can vary by model and
environment.

</details>
