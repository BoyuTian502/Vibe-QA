import type {
  DashboardIssue,
  DashboardRun,
  DashboardRunStatus,
  DashboardStep,
  DashboardTimelineEvent
} from "./types.js";
import type { BugAnalysis } from "./bug-analysis.js";
import { classifyProductOutcome, type ProductOutcome } from "./product-outcome.js";
import type {
  CreateTestRequestInput,
  QATestMode,
  UserTestRequest
} from "./test-workflow.js";

export type DashboardSection = "dashboard" | "history" | "details" | "new-test";

// Keep this static: the response CSP permits only this exact inline script.
export const AUTHENTICATION_FORM_SCRIPT = `
(() => {
  const toggle = document.querySelector('input[name="loginRequired"]');
  const fields = [
    document.querySelector('input[name="loginUsername"]'),
    document.querySelector('input[name="loginPassword"]')
  ];
  const syncAuthentication = () => {
    for (const field of fields) {
      if (!(field instanceof HTMLInputElement) || !(toggle instanceof HTMLInputElement)) continue;
      field.disabled = !toggle.checked;
      field.required = toggle.checked;
      if (!toggle.checked) field.value = "";
    }
  };
  toggle?.addEventListener("change", syncAuthentication);
  syncAuthentication();
  const expected = document.querySelector('#expectedBehavior');
  const hint = document.querySelector('#expected-text-hint');
  const syncMode = () => {
    const exploratory = document.querySelector('input[name="mode"]:checked')?.value === "exploratory";
    if (expected instanceof HTMLTextAreaElement) expected.required = !exploratory;
    if (hint) hint.textContent = exploratory
      ? "Optional. Exploratory mode autonomously navigates and evaluates safe UI states. Text adds a final-page check."
      : "Required for this local check. Enter text expected on the final page; every non-empty line must appear. This is not a natural-language instruction.";
  };
  document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener("change", syncMode));
  syncMode();
})();
`;

export function renderDashboardPage(
  runs: DashboardRun[],
  selectedRun: DashboardRun | null,
  activeSection: DashboardSection = "dashboard",
  analysis: BugAnalysis | null = null
): string {
  return renderDocument(
    selectedRun
      ? renderReport(runs, selectedRun, activeSection, analysis)
      : renderEmptyState(runs, activeSection)
  );
}

export function renderHistoryPage(runs: DashboardRun[]): string {
  return renderDocument(
    runs.length > 0 ? renderHistory(runs) : renderEmptyState(runs, "history")
  );
}

export function renderTestCreationPage(
  runs: DashboardRun[],
  availableModes: readonly QATestMode[],
  error: string | null = null,
  values: CreateTestRequestInput | null = null
): string {
  const selectedMode =
    values && availableModes.includes(values.mode) ? values.mode : null;
  values ??= {
    websiteUrl: "",
    objective: "",
    expectedBehavior: "",
    mode: "functional",
    credentials: null
  };
  const workflowAvailable = availableModes.length > 0;
  const availabilityLabel =
    availableModes.length === 3
      ? "All test modes ready"
      : availableModes.includes("exploratory")
        ? "Exploratory mode ready"
        : "Test runner not configured";
  return renderDocument(`
    <div class="app-frame">
      ${renderSidebar(runs, runs[0]?.id ?? null, "new-test", false)}
      <main class="main-content test-entry-shell">
        <header class="report-header test-entry-header">
          <div>
            <p class="kicker">Create test request</p>
            <h1>Run a website test</h1>
            <p class="header-summary">Turn a testing objective into an evidence-backed browser run.</p>
          </div>
          <span class="planner-status planner-${workflowAvailable ? "ready" : "offline"}">
            ${availabilityLabel}
          </span>
        </header>

        <section class="panel test-form-panel">
          <div class="section-heading">
            <div>
              <p class="section-label">Test definition</p>
              <h2>New QA test</h2>
            </div>
            <span class="count-label">Local browser</span>
          </div>
          <form class="test-request-form" method="post" action="/tests">
            ${error ? `<div class="form-error" role="alert">${escapeHtml(error)}</div>` : ""}
            <label class="field-group" for="websiteUrl">
              <span>Target page</span>
              <input
                id="websiteUrl"
                name="websiteUrl"
                type="url"
                inputmode="url"
                maxlength="2048"
                placeholder="https://example.com/login"
                value="${escapeAttribute(values.websiteUrl)}"
                required
              />
            </label>
            <fieldset class="mode-fieldset">
              <legend>Testing mode</legend>
              <div class="mode-control">
                ${renderModeOption("functional", selectedMode, availableModes)}
                ${renderModeOption("regression", selectedMode, availableModes)}
                ${renderModeOption("exploratory", selectedMode, availableModes)}
              </div>
            </fieldset>
            <label class="field-group" for="objective">
              <span>Test objective</span>
              <textarea
                id="objective"
                name="objective"
                maxlength="1000"
                rows="5"
                placeholder="Test login functionality"
                required
              >${escapeHtml(values.objective)}</textarea>
            </label>
            <label class="field-group" for="expectedBehavior">
              <span>Expected visible page text</span>
              <textarea
                id="expectedBehavior"
                name="expectedBehavior"
                maxlength="1500"
                rows="4"
                placeholder="Dashboard"
                aria-describedby="expected-text-hint"
                ${selectedMode === "exploratory" ? "" : "required"}
              >${escapeHtml(values.expectedBehavior)}</textarea>
            </label>
            <p id="expected-text-hint" class="header-summary">${selectedMode === "exploratory" ? "Optional. Exploratory mode autonomously navigates and evaluates safe UI states. Text adds a final-page check." : "Required for this local check. Enter text expected on the final page; every non-empty line must appear. This is not a natural-language instruction."}</p>
            <section class="auth-configuration" aria-labelledby="authentication-heading">
              <div class="auth-heading">
                <div>
                  <span class="field-label" id="authentication-heading">Authentication</span>
                  <strong>Temporary login</strong>
                </div>
                <label class="auth-toggle">
                  <input
                    type="checkbox"
                    name="loginRequired"
                    ${values.credentials ? "checked" : ""}
                  />
                  <span>Login required</span>
                </label>
              </div>
              <div class="auth-fields">
                <label class="field-group" for="loginUsername">
                  <span>Username or email</span>
                  <input
                    id="loginUsername"
                    name="loginUsername"
                    type="text"
                    maxlength="512"
                    autocomplete="off"
                    spellcheck="false"
                    ${values.credentials ? "required" : "disabled"}
                  />
                </label>
                <label class="field-group" for="loginPassword">
                  <span>Password</span>
                  <input
                    id="loginPassword"
                    name="loginPassword"
                    type="password"
                    maxlength="512"
                    autocomplete="off"
                    ${values.credentials ? "required" : "disabled"}
                  />
                </label>
              </div>
              <p>Credentials are kept in memory for this run and are not included in planner prompts, reports, or evidence.</p>
            </section>
            <div class="form-actions">
              <span>Planning and browser execution use the existing safety policy.</span>
              <button type="submit" ${workflowAvailable ? "" : "disabled"}>Run test</button>
            </div>
          </form>
        </section>
        <script>${AUTHENTICATION_FORM_SCRIPT}</script>
      </main>
    </div>
  `);
}

export function renderTestRequestPage(
  runs: DashboardRun[],
  request: UserTestRequest
): string {
  const isPending = request.status === "queued" || request.status === "running";
  const statusTitle = testRequestStatusTitle(request);
  const statusCopy = testRequestStatusCopy(request);
  return renderDocument(
    `
      <div class="app-frame">
        ${renderSidebar(runs, runs[0]?.id ?? null, "new-test", false)}
        <main class="main-content test-entry-shell">
          <header class="report-header test-entry-header">
            <div>
              <p class="kicker">${escapeHtml(testModeLabel(request.mode))} test request</p>
              <h1>${escapeHtml(request.objective)}</h1>
              <p class="header-summary">${escapeHtml(request.websiteUrl)}</p>
            </div>
            <code class="request-id">${escapeHtml(request.id)}</code>
          </header>

          <section data-outcome="${request.outcome?.kind ?? request.status}" class="panel request-status-panel request-${escapeHtml(request.status)} outcome-${request.outcome?.tone ?? "attention"}">
            <div class="request-status-mark" aria-hidden="true">${request.status === "completed" ? (request.testStatus === "passed" ? "OK" : "!") : request.status === "failed" ? "!" : "..."}</div>
            <div class="request-status-copy">
              <p class="section-label">Execution status</p>
              <h2>${escapeHtml(statusTitle)}</h2>
              <p>${escapeHtml(statusCopy)}</p>
              ${request.error ? `<details><summary>Execution details</summary><p>${escapeHtml(request.error)}</p></details>` : ""}
            </div>
            <span class="request-status-tag">${escapeHtml(request.status)}</span>
          </section>

          <section class="panel request-facts" aria-label="Test request details">
            ${renderRequestFact("Mode", testModeLabel(request.mode))}
            ${renderRequestFact("Authentication", request.authenticationUsed ? "Temporary login" : "None")}
            ${renderRequestFact("Created", formatTimestamp(request.createdAt))}
            ${renderRequestFact("Completed", request.completedAt ? formatTimestamp(request.completedAt) : "Pending")}
            ${renderRequestFact("Test result", request.outcome?.label ?? (request.testStatus ? statusLabelFor(request.testStatus) : "Pending"))}
          </section>

          <section class="panel expected-behavior-panel">
            <span>Expected visible page text</span>
            <p>${escapeHtml(request.expectedBehavior || "Not specified")}</p>
          </section>

          <div class="request-actions">
            <a class="secondary-action" href="/tests/new">Create another test</a>
            ${request.runId ? `<a class="primary-action" href="/runs/${encodeURIComponent(request.runId)}">View test report</a>` : ""}
          </div>
        </main>
      </div>
    `,
    isPending ? 2 : null
  );
}

function renderReport(
  runs: DashboardRun[],
  run: DashboardRun,
  activeSection: DashboardSection,
  analysis: BugAnalysis | null
): string {
  const outcome = runOutcome(run);
  const statusLabel = outcome.label;
  const statusSummary = outcome.summary;

  return `
    <div class="app-frame">
      ${renderSidebar(runs, run.id, activeSection, true)}
      <main class="main-content">
        <header class="report-header">
          <div>
            <p class="kicker">Automated QA run</p>
            <h1>${escapeHtml(run.goal)}</h1>
          </div>
          <div class="run-identity">
            <span>Run ID</span>
            <code>${escapeHtml(run.id)}</code>
            <time>${escapeHtml(formatTimestamp(run.startedAt))}</time>
          </div>
        </header>

        <section id="overview" data-outcome="${outcome.kind}" class="status-band status-${escapeHtml(run.status)} outcome-${outcome.tone}">
          <div class="status-mark" aria-hidden="true">${run.status === "failed" ? "!" : "OK"}</div>
          <div class="status-copy">
            <p class="section-label">Test status</p>
            <h2>${escapeHtml(statusLabel)}</h2>
            <p>${escapeHtml(statusSummary)}</p>
          </div>
          <span class="status-tag outcome-tag-${outcome.tone}">${escapeHtml(statusLabel)}</span>
        </section>

        <section class="run-context" aria-label="Test context">
          ${renderRequestFact("Mode", run.execution?.mode ? sentenceCase(run.execution.mode) : "Recorded workflow")}
          ${renderRequestFact("Target URL", run.targetUrl ?? "Not recorded")}
          ${renderRequestFact("Finished", run.execution ? terminationLabel(run.execution.terminationReason) : outcome.label)}
        </section>

        <section class="metrics" aria-label="Run summary">
          ${renderMetric("Steps passed", `${run.passedStepCount}/${run.stepCount}`)}
          ${renderMetric("Findings", String(run.issueCount))}
          ${renderMetric("Screenshots", String(run.screenshotCount))}
          ${renderMetric("Duration", formatDuration(run.durationMs))}
        </section>

        <div class="report-grid">
          <section id="steps" class="panel steps-panel">
            <div class="section-heading">
              <div>
                <p class="section-label">${run.execution?.mode === "exploratory" ? "Exploratory journey" : "Test journey"}</p>
                <h2>Test steps</h2>
              </div>
              <span class="count-label">${run.stepCount} total</span>
            </div>
            ${run.execution ? `<p class="header-summary execution-summary">${run.execution.mode === "exploratory" ? "Autonomous exploration" : "Planned workflow"}. ${run.execution.pageCount} pages and ${run.execution.stateCount} page states observed.</p>` : ""}
            ${renderSteps(run.steps)}
          </section>

          <section id="issue" class="panel issue-panel">
            <div class="section-heading">
              <div>
                <p class="section-label">Evaluation</p>
                <h2>${run.primaryIssue ? "Detected issue" : "Run outcome"}</h2>
              </div>
            </div>
            ${run.primaryIssue ? renderIssue(run.primaryIssue) : `<div class="issue-content"><h3>${escapeHtml(outcome.label)}</h3><p>${escapeHtml(outcome.summary)}</p></div>`}
          </section>
        </div>

        <section id="analysis" class="panel analysis-panel">
          <div class="section-heading">
            <div>
              <p class="section-label">Evidence explanation</p>
              <h2>AI bug analysis</h2>
            </div>
            ${renderAnalysisSource(analysis)}
          </div>
          ${!run.primaryIssue && outcome.kind !== "PASSED" ? '<p class="empty-copy">No target-site bug analysis is generated for this execution outcome.</p>' : renderBugAnalysis(analysis, run.primaryIssue !== null)}
        </section>

        <section id="timeline" class="panel timeline-panel">
          <div class="section-heading">
            <div>
              <p class="section-label">Agent trace</p>
              <h2>Execution timeline</h2>
            </div>
            <span class="count-label">${run.timeline.length} events</span>
          </div>
          <details class="trace-details"><summary>View action timeline and technical details</summary>
            ${run.execution ? `<p class="execution-summary">${run.execution.modelInvocationCount} model calls. Termination: <code>${escapeHtml(run.execution.terminationReason)}</code>.</p>` : ""}
            ${run.errors.length ? `<ul class="diagnostic-errors">${run.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
            ${renderTimeline(run.timeline)}
          </details>
        </section>

        <section id="evidence" class="evidence-section">
          <div class="section-heading">
            <div>
              <p class="section-label">Browser evidence</p>
              <h2>Evidence screenshots</h2>
            </div>
            <span class="count-label">${run.screenshotCount} captured</span>
          </div>
          ${renderScreenshots(run)}
        </section>

        <footer class="page-footer">
          <span>Vibe-QA local report dashboard</span>
          <span>Read-only artifact view</span>
        </footer>
      </main>
    </div>
  `;
}

function renderSidebar(
  runs: DashboardRun[],
  selectedRunId: string | null,
  activeSection: DashboardSection,
  showReportSections: boolean
): string {
  const options = runs
    .map(
      (run) => `
        <option value="${escapeAttribute(run.id)}" ${run.id === selectedRunId ? "selected" : ""}>
          ${escapeHtml(shortRunLabel(run))}
        </option>
      `
    )
    .join("");

  return `
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="Vibe-QA report dashboard">
        <span class="brand-mark">VQ</span>
        <span><strong>Vibe-QA</strong><small>Report dashboard</small></span>
      </a>

      <nav class="product-nav" aria-label="Primary navigation">
        ${renderProductNavLink("Dashboard", "/", "dashboard", activeSection)}
        ${renderProductNavLink("History", "/history", "history", activeSection)}
        ${renderProductNavLink(
          "Run Details",
          selectedRunId ? `/runs/${encodeURIComponent(selectedRunId)}` : "/",
          "details",
          activeSection
        )}
        ${renderProductNavLink("New Test", "/tests/new", "new-test", activeSection)}
      </nav>

      <form class="run-picker" method="get" action="/runs">
        <label for="run">Saved run</label>
        <div class="picker-row">
          <select id="run" name="run">${options}</select>
          <button type="submit">Open</button>
        </div>
      </form>

      ${
        showReportSections
          ? `<nav class="section-nav" aria-label="Run detail sections">
              <span class="nav-label">Run details</span>
              <a href="#overview"><span>01</span>Overview</a>
              <a href="#steps"><span>02</span>Test steps</a>
              <a href="#issue"><span>03</span>Detected issue</a>
              <a href="#analysis"><span>04</span>AI analysis</a>
              <a href="#timeline"><span>05</span>Timeline</a>
              <a href="#evidence"><span>06</span>Evidence</a>
            </nav>`
          : ""
      }

      <div class="sidebar-note">
        <span class="live-dot" aria-hidden="true"></span>
        <span>${runs.length} local run${runs.length === 1 ? "" : "s"} indexed</span>
      </div>
    </aside>
  `;
}

function renderHistory(runs: DashboardRun[]): string {
  const passedRuns = runs.filter((run) => run.status === "passed").length;
  const totalBugs = runs.reduce((total, run) => total + run.issueCount, 0);
  const totalScreenshots = runs.reduce((total, run) => total + run.screenshotCount, 0);
  const passRate = runs.length > 0 ? Math.round((passedRuns / runs.length) * 100) : 0;

  return `
    <div class="app-frame">
      ${renderSidebar(runs, runs[0]?.id ?? null, "history", false)}
      <main class="main-content">
        <header class="report-header history-header">
          <div>
            <p class="kicker">Test archive</p>
            <h1>QA run history</h1>
            <p class="header-summary">Local test runs, newest first.</p>
          </div>
          <div class="run-identity">
            <span>Indexed runs</span>
            <strong>${runs.length}</strong>
            <time>Newest first</time>
          </div>
        </header>

        <section class="metrics history-metrics" aria-label="History summary">
          ${renderMetric("Total runs", String(runs.length))}
          ${renderMetric("Pass rate", `${passRate}%`)}
          ${renderMetric("Findings", String(totalBugs))}
          ${renderMetric("Screenshots", String(totalScreenshots))}
        </section>

        <section class="panel history-panel">
          <div class="section-heading">
            <div>
              <p class="section-label">Saved test runs</p>
              <h2>Execution history</h2>
            </div>
            <span class="count-label">${runs.length} total</span>
          </div>
          <div class="history-table" role="table" aria-label="QA run history">
            <div class="history-row history-table-head" role="row">
              <span role="columnheader">Run</span>
              <span role="columnheader">Run time</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Findings</span>
              <span role="columnheader">Screenshots</span>
              <span role="columnheader">Duration</span>
              <span role="columnheader">Details</span>
            </div>
            ${runs.map(renderHistoryRow).join("")}
          </div>
        </section>

        <footer class="page-footer">
          <span>Vibe-QA local report dashboard</span>
          <span>${runs.length} run${runs.length === 1 ? "" : "s"} discovered automatically</span>
        </footer>
      </main>
    </div>
  `;
}

function renderHistoryRow(run: DashboardRun): string {
  const outcome = runOutcome(run);
  const statusLabel = outcome.label;
  return `
    <article class="history-row" role="row">
      <div class="history-run" role="cell">
        <strong>${escapeHtml(run.goal)}</strong>
        <code>${escapeHtml(run.id)}</code>
      </div>
      ${renderHistoryCell("Run time", `<time>${escapeHtml(formatTimestamp(run.startedAt))}</time>`)}
      ${renderHistoryCell(
        "Status",
        `<span class="status-tag outcome-tag-${outcome.tone}">${escapeHtml(statusLabel)}</span>`
      )}
      ${renderHistoryCell("Findings", `<strong>${run.issueCount}</strong>`)}
      ${renderHistoryCell("Screenshots", `<strong>${run.screenshotCount}</strong>`)}
      ${renderHistoryCell("Duration", `<strong>${escapeHtml(formatDuration(run.durationMs))}</strong>`)}
      <div class="history-action" role="cell">
        <a href="/runs/${encodeURIComponent(run.id)}">View details</a>
      </div>
    </article>
  `;
}

function renderHistoryCell(label: string, content: string): string {
  return `
    <div class="history-cell" role="cell">
      <span class="mobile-label">${escapeHtml(label)}</span>
      ${content}
    </div>
  `;
}

function renderProductNavLink(
  label: string,
  href: string,
  section: DashboardSection,
  activeSection: DashboardSection
): string {
  const active = section === activeSection;
  return `<a href="${escapeAttribute(href)}" class="${active ? "active" : ""}" ${active ? 'aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
}

function renderEmptyState(
  runs: DashboardRun[],
  activeSection: DashboardSection
): string {
  return `
    <div class="app-frame">
      ${renderSidebar(runs, null, activeSection, false)}
      <main class="main-content empty-shell">
        <section class="empty-state">
          <span class="empty-mark">VQ</span>
          <p class="kicker">Report dashboard</p>
          <h1>No test runs yet</h1>
          <a class="primary-action" href="/tests/new">New Test</a>
        </section>
      </main>
    </div>
  `;
}

function renderMetric(label: string, value: string): string {
  return `
    <div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderRequestFact(label: string, value: string): string {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderModeOption(
  mode: QATestMode,
  selectedMode: QATestMode | null,
  availableModes: readonly QATestMode[]
): string {
  const available = availableModes.includes(mode);
  return `
    <label class="mode-option ${available ? "" : "mode-disabled"}">
      <input
        type="radio"
        name="mode"
        required
        value="${mode}"
        ${mode === selectedMode ? "checked" : ""}
        ${available ? "" : "disabled"}
      />
      <span>${escapeHtml(testModeLabel(mode))}</span>
    </label>
  `;
}

function testModeLabel(mode: QATestMode): string {
  return `${mode[0]?.toUpperCase() ?? ""}${mode.slice(1)}`;
}

function testRequestStatusTitle(request: UserTestRequest): string {
  if (request.status === "queued") {
    return "Test queued";
  }
  if (request.status === "running") {
    return "Agent is testing the website";
  }
  if (request.status === "completed") {
    return request.outcome?.label ?? "Test finished";
  }
  return request.outcome?.label ?? "Test could not run";
}

function testRequestStatusCopy(request: UserTestRequest): string {
  if (request.status === "queued") {
    return "The request is waiting for local browser execution.";
  }
  if (request.status === "running") {
    return "Vibe-QA is planning actions, operating the browser, and collecting evidence.";
  }
  if (request.status === "completed") {
    if (request.outcome) return request.outcome.summary;
    return request.testStatus === "passed"
      ? "The objective completed without a detected issue."
      : "The evaluator recorded a failure and generated a test report.";
  }
  return (
    request.outcome?.summary ??
    request.error ??
    "The test stopped before a report could be generated."
  );
}

function renderSteps(steps: DashboardStep[]): string {
  if (steps.length === 0) {
    return '<p class="empty-copy">No executed steps were recorded.</p>';
  }

  return `
    <ol class="step-list">
      ${steps
        .map(
          (step) => `
            <li class="step-row">
              <span class="step-index">${String(step.index + 1).padStart(2, "0")}</span>
              <span class="result-icon result-${escapeHtml(step.status)}" aria-label="${escapeHtml(statusLabelFor(step.status))}">
                ${step.status === "passed" ? "OK" : "!"}
              </span>
              <div class="step-copy">
                <strong>${escapeHtml(step.name)}</strong>
                <span>${escapeHtml(step.actionLabel)}</span>
                ${step.reason ? `<p>${escapeHtml(step.reason)}</p>` : ""}
                ${step.errors.length ? `<details><summary>Step details</summary><p>${step.errors.map(escapeHtml).join("<br />")}</p></details>` : ""}
              </div>
            </li>
          `
        )
        .join("")}
    </ol>
  `;
}

function renderIssue(issue: DashboardIssue | null): string {
  if (!issue) {
    return `
      <div class="issue-empty">
        <span class="result-icon result-passed">OK</span>
        <strong>No issue detected</strong>
        <p>The evaluator did not produce a BugReport for this run.</p>
      </div>
    `;
  }

  const consoleErrors = issue.consoleErrors
    .map(
      (error) => `
        <li>
          <span>${escapeHtml(error.type)}</span>
          <code>${escapeHtml(error.text)}</code>
        </li>
      `
    )
    .join("");

  return `
    <article class="issue-content">
      <div class="issue-meta">
        <span>${escapeHtml(issue.category)}</span>
        <span>${escapeHtml(issue.stepName)}</span>
      </div>
      <h3>${escapeHtml(sentenceCase(issue.title))}</h3>
      <p>${escapeHtml(issue.description)}</p>
      ${
        consoleErrors
          ? `<div class="error-block"><span>Browser error</span><ul>${consoleErrors}</ul></div>`
          : ""
      }
      ${
        issue.screenshotUrl
          ? `<a class="evidence-link" href="${escapeAttribute(issue.screenshotUrl)}" target="_blank" rel="noreferrer">Open issue screenshot</a>`
          : ""
      }
    </article>
  `;
}

function renderAnalysisSource(analysis: BugAnalysis | null): string {
  if (!analysis) {
    return '<span class="analysis-source analysis-source-none">Not needed</span>';
  }
  const label = analysis.source === "ai" ? "AI generated" : "Local baseline";
  return `<span class="analysis-source analysis-source-${escapeHtml(analysis.source)}">${label}</span>`;
}

function renderBugAnalysis(analysis: BugAnalysis | null, hasIssue: boolean): string {
  if (!analysis) {
    return `
      <div class="analysis-empty">
        <span class="result-icon result-passed">OK</span>
        <div>
          <strong>${hasIssue ? "Analysis unavailable" : "No bug analysis needed"}</strong>
          <p>${hasIssue ? "The report does not contain enough structured evidence for an explanation." : "This run completed without a BugReport to analyze."}</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="analysis-content">
      ${analysis.notice ? `<p class="analysis-notice">${escapeHtml(analysis.notice)}</p>` : ""}
      <div class="analysis-summary">
        <div>
          <span class="analysis-label">Bug summary</span>
          <p>${escapeHtml(analysis.summary)}</p>
        </div>
        <div class="severity-block severity-${escapeHtml(analysis.severity)}">
          <span>Severity</span>
          <strong>${escapeHtml(sentenceCase(analysis.severity))}</strong>
        </div>
      </div>
      <div class="analysis-columns">
        <div class="analysis-section">
          <span class="analysis-label">Likely root cause</span>
          <p>${escapeHtml(analysis.rootCause)}</p>
        </div>
        <div class="analysis-section">
          <span class="analysis-label">Suggested fixes</span>
          <ol>${analysis.suggestedFixes.map((fix) => `<li>${escapeHtml(fix)}</li>`).join("")}</ol>
        </div>
      </div>
      <div class="severity-reasoning">
        <span class="analysis-label">Why this severity</span>
        <p>${escapeHtml(analysis.severityReasoning)}</p>
      </div>
    </div>
  `;
}

function renderTimeline(events: DashboardTimelineEvent[]): string {
  if (events.length === 0) {
    return '<p class="empty-copy">No trace events were recorded.</p>';
  }

  return `
    <ol class="timeline">
      ${events.map(renderTimelineEvent).join("")}
    </ol>
  `;
}

function renderTimelineEvent(event: DashboardTimelineEvent): string {
  const metadata = [
    event.safetyDecision ? `Safety: ${event.safetyDecision}` : null,
    event.approvalStatus ? `Approval: ${event.approvalStatus}` : null,
    event.observationTitle
  ].filter((item): item is string => item !== null);

  return `
    <li class="timeline-event timeline-${escapeHtml(event.status)}">
      <div class="timeline-marker" aria-hidden="true"></div>
      <div class="timeline-time">
        <span>${String(event.index + 1).padStart(2, "0")}</span>
        <time>${escapeHtml(formatTime(event.timestamp))}</time>
      </div>
      <div class="timeline-copy">
        <strong>${escapeHtml(event.label)}</strong>
        ${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ""}
        ${event.error ? `<p class="timeline-error">${escapeHtml(event.error)}</p>` : ""}
        ${
          metadata.length > 0
            ? `<div class="timeline-meta">${metadata.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
            : ""
        }
        ${
          event.observationUrl
            ? `<code class="timeline-url">${escapeHtml(event.observationUrl)}</code>`
            : ""
        }
      </div>
    </li>
  `;
}

function renderScreenshots(run: DashboardRun): string {
  if (run.screenshots.length === 0) {
    return '<p class="empty-copy">No screenshots were captured for this run.</p>';
  }

  return `
    <div class="screenshot-grid">
      ${run.screenshots
        .map(
          (screenshot, index) => `
            <figure class="screenshot-item">
              <a href="${escapeAttribute(screenshot.url)}" target="_blank" rel="noreferrer">
                <img src="${escapeAttribute(screenshot.url)}" alt="Browser evidence ${index + 1}" />
              </a>
              <figcaption>
                <span>Evidence ${String(index + 1).padStart(2, "0")}</span>
                <code>${escapeHtml(screenshot.name)}</code>
              </figcaption>
            </figure>
          `
        )
        .join("")}
    </div>
  `;
}

function shortRunLabel(run: DashboardRun): string {
  const date = formatTimestamp(run.startedAt);
  const status = runOutcome(run).label;
  return `${date} - ${status}`;
}

function statusLabelFor(status: DashboardRunStatus): string {
  if (status === "passed") {
    return "Passed";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Unknown";
}

function runOutcome(run: DashboardRun): ProductOutcome {
  return (
    run.outcome ??
    classifyProductOutcome({
      status: run.status,
      errors: run.errors,
      bugReports: run.primaryIssue ? [run.primaryIssue] : []
    })
  );
}

function terminationLabel(reason: string): string {
  const labels: Record<string, string> = {
    "workflow-complete": "Checks completed",
    "workflow-failed": "See outcome above",
    "approval-required": "Stopped before a sensitive action",
    "agent-error": "Execution interrupted",
    "page-error": "Stopped after capturing a page failure",
    STALE_ELEMENT_RECOVERY_FAILED: "Target recovery limit reached",
    "max-steps": "Action limit reached",
    "planner-stopped": "No next action selected",
    "null-retry-exhausted": "Objective not confirmed",
    "candidate-exhausted": "No safe candidates remain",
    "goal-complete": "Completion check satisfied"
  };
  return labels[reason] ?? sentenceCase(reason.replaceAll("-", " "));
}

export function renderUnavailablePage(): string {
  return renderDocument(
    `<main class="empty-state unavailable-page"><p class="kicker">Vibe-QA</p><h1>Run unavailable</h1><p>The local report may have been moved, removed, or could not be read.</p><a class="primary-action" href="/history">History</a> <a class="secondary-action" href="/tests/new">New Test</a></main>`
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Time unavailable";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatTime(value: string | null): string {
  if (!value) {
    return "--:--:--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "Unavailable";
  }
  if (value < 1000) {
    return `${value} ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)} s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function renderDocument(body: string, refreshSeconds: number | null = null): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    ${refreshSeconds === null ? "" : `<meta http-equiv="refresh" content="${refreshSeconds}" />`}
    <title>Vibe-QA Report Dashboard</title>
    <style>${styles()}</style>
  </head>
  <body>${body}</body>
</html>`;
}

function styles(): string {
  return `
    :root {
      color: #1c2733;
      background: #f3f5f7;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-synthesis: none;
      letter-spacing: 0;
    }
    * { box-sizing: border-box; }
    h1, h2, h3, p, strong, code, summary { overflow-wrap: anywhere; }
    .run-context { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 20px; max-width: 1320px; margin: 0 auto 24px; padding: 16px 0; border-bottom: 1px solid #d6dde2; }
    .run-context > div { min-width: 0; display: grid; gap: 6px; }
    .run-context span { color: #6d7b86; font-size: 0.72rem; }
    .run-context strong { font-size: 0.85rem; }
    .trace-details > summary { cursor: pointer; padding: 18px 20px; color: #245fbd; font-size: 0.85rem; }
    .diagnostic-errors { padding: 0 36px; font-size: 0.8rem; }
    .unavailable-page { padding: 80px 20px; }
    .status-band.outcome-attention { background: #fff9e8; border-left-color: #b17d19; }
    .outcome-tag-attention { color: #805a15; }
    .outcome-tag-success { color: #187056; }
    .outcome-tag-issue { color: #b63737; }
    .request-status-panel.outcome-attention { border-left-color: #b17d19; }
    .status-tag { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-height: 100vh; }
    a { color: inherit; }
    button, input, select, textarea { font: inherit; }
    button, input, select, textarea, .panel, .status-band, .screenshot-item { border-radius: 6px; }
    .app-frame { min-height: 100vh; }
    .sidebar {
      background: #142029;
      color: #f7fafc;
      display: flex;
      flex-direction: column;
      gap: 30px;
      height: 100vh;
      left: 0;
      overflow-y: auto;
      padding: 26px 22px;
      position: fixed;
      top: 0;
      width: 252px;
      z-index: 10;
    }
    .brand { align-items: center; display: flex; gap: 12px; text-decoration: none; }
    .brand-mark, .empty-mark {
      align-items: center;
      background: #f0c24b;
      color: #142029;
      display: inline-flex;
      font-size: 0.82rem;
      font-weight: 900;
      height: 38px;
      justify-content: center;
      width: 38px;
    }
    .brand strong, .brand small { display: block; }
    .brand strong { font-size: 1rem; }
    .brand small { color: #9fb0bd; font-size: 0.75rem; margin-top: 2px; }
    .run-picker { display: grid; gap: 8px; }
    .run-picker label, .section-label, .kicker {
      color: #6d7b86;
      font-size: 0.72rem;
      font-weight: 800;
      margin: 0;
      text-transform: uppercase;
    }
    .run-picker label { color: #9fb0bd; }
    .picker-row { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; }
    .picker-row select {
      background: #202f3a;
      border: 1px solid #3a4a56;
      color: #f7fafc;
      min-width: 0;
      padding: 9px 10px;
    }
    .picker-row button {
      background: #f0c24b;
      border: 1px solid #f0c24b;
      color: #142029;
      cursor: pointer;
      font-weight: 800;
      padding: 9px 12px;
    }
    .product-nav { border-bottom: 1px solid #2f404c; display: grid; padding-bottom: 18px; }
    .product-nav a {
      border-left: 3px solid transparent;
      color: #c8d2d9;
      font-size: 0.86rem;
      font-weight: 700;
      padding: 10px 12px;
      text-decoration: none;
    }
    .product-nav a:hover { background: #202f3a; color: white; }
    .product-nav a.active { background: #202f3a; border-left-color: #f0c24b; color: white; }
    .section-nav { display: grid; gap: 4px; }
    .nav-label { color: #718491; font-size: 0.65rem; font-weight: 900; padding: 0 12px 6px; text-transform: uppercase; }
    .section-nav a {
      align-items: center;
      border-left: 2px solid transparent;
      color: #c8d2d9;
      display: flex;
      font-size: 0.88rem;
      gap: 12px;
      padding: 10px 12px;
      text-decoration: none;
    }
    .section-nav a:hover { background: #202f3a; border-left-color: #f0c24b; color: white; }
    .section-nav span { color: #718491; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.72rem; }
    .sidebar-note {
      align-items: center;
      color: #9fb0bd;
      display: flex;
      font-size: 0.78rem;
      gap: 9px;
      margin-top: auto;
    }
    .live-dot { background: #34a37a; border-radius: 50%; height: 8px; width: 8px; }
    .main-content { margin-left: 252px; padding: 34px clamp(24px, 4vw, 64px) 28px; }
    .report-header {
      align-items: end;
      display: flex;
      gap: 28px;
      justify-content: space-between;
      margin: 0 auto 26px;
      max-width: 1320px;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: 2rem; line-height: 1.18; margin: 7px 0 0; max-width: 760px; }
    h2 { font-size: 1.18rem; margin: 5px 0 0; }
    h3 { font-size: 1rem; line-height: 1.4; margin: 0; }
    .run-identity { align-items: end; display: grid; gap: 4px; justify-items: end; }
    .run-identity span { color: #6d7b86; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; }
    .run-identity code, .timeline-url, .issue-content code, figcaption code {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .run-identity code { font-size: 0.78rem; }
    .run-identity time { color: #6d7b86; font-size: 0.78rem; }
    .run-identity strong { font-size: 1.55rem; }
    .header-summary { color: #6d7b86; font-size: 0.88rem; margin: 10px 0 0; }
    .status-band {
      align-items: center;
      border: 1px solid #d6dde2;
      display: grid;
      gap: 18px;
      grid-template-columns: auto minmax(0, 1fr) auto;
      margin: 0 auto;
      max-width: 1320px;
      padding: 20px 22px;
    }
    .status-failed { background: #fff7f5; border-left: 4px solid #d94b47; }
    .status-passed { background: #f2faf6; border-left: 4px solid #27876b; }
    .status-unknown { background: #fffaf0; border-left: 4px solid #c28a22; }
    .status-mark {
      align-items: center;
      background: #1c2733;
      color: white;
      display: flex;
      font-size: 0.76rem;
      font-weight: 900;
      height: 38px;
      justify-content: center;
      width: 38px;
    }
    .status-copy p:last-child { color: #586875; font-size: 0.9rem; margin: 7px 0 0; }
    .status-tag {
      border: 1px solid currentColor;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 900;
      padding: 6px 9px;
      text-transform: uppercase;
    }
    .status-tag-failed { color: #b43632; }
    .status-tag-passed { color: #187056; }
    .status-tag-unknown { color: #9a6815; }
    .metrics {
      border-bottom: 1px solid #d6dde2;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin: 0 auto 30px;
      max-width: 1320px;
    }
    .metric { border-right: 1px solid #d6dde2; display: grid; gap: 3px; padding: 18px 20px; }
    .metric:last-child { border-right: 0; }
    .metric span { color: #6d7b86; font-size: 0.74rem; font-weight: 700; }
    .metric strong { font-size: 1.45rem; }
    .report-grid {
      align-items: start;
      display: grid;
      gap: 20px;
      grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
      margin: 0 auto 20px;
      max-width: 1320px;
    }
    .panel { background: white; border: 1px solid #d6dde2; overflow: hidden; }
    .section-heading {
      align-items: center;
      border-bottom: 1px solid #e3e8ec;
      display: flex;
      justify-content: space-between;
      padding: 18px 20px;
    }
    .count-label { color: #6d7b86; font-size: 0.75rem; font-weight: 700; }
    .step-list, .timeline { list-style: none; margin: 0; padding: 0; }
    .step-row {
      align-items: start;
      border-bottom: 1px solid #edf0f2;
      display: grid;
      gap: 13px;
      grid-template-columns: 28px 30px minmax(0, 1fr);
      padding: 15px 20px;
    }
    .step-row:last-child { border-bottom: 0; }
    .step-index { color: #93a0aa; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.72rem; padding-top: 5px; }
    .result-icon {
      align-items: center;
      border-radius: 4px;
      display: inline-flex;
      font-size: 0.62rem;
      font-weight: 900;
      height: 24px;
      justify-content: center;
      width: 24px;
    }
    .result-passed { background: #ddf3e9; color: #176b52; }
    .result-failed { background: #fde3df; color: #a62e2a; }
    .result-unknown { background: #f6ead0; color: #87601a; }
    .step-copy { min-width: 0; }
    .step-copy strong, .step-copy span { display: block; }
    .step-copy strong { font-size: 0.88rem; }
    .step-copy span, .step-copy p { color: #6d7b86; font-size: 0.78rem; }
    .step-copy span { margin-top: 3px; }
    .step-copy p { line-height: 1.45; margin: 7px 0 0; }
    .issue-panel { border-top: 3px solid #d94b47; }
    .issue-content { display: grid; gap: 15px; padding: 20px; }
    .issue-meta { display: flex; flex-wrap: wrap; gap: 7px; }
    .issue-meta span {
      background: #eef2f4;
      border-radius: 4px;
      color: #53636f;
      font-size: 0.68rem;
      font-weight: 800;
      padding: 5px 7px;
      text-transform: uppercase;
    }
    .issue-content > p { color: #586875; font-size: 0.88rem; line-height: 1.55; margin: 0; }
    .error-block { background: #241e21; border-radius: 6px; color: #f9edeb; padding: 14px; }
    .error-block > span { color: #e7a29a; font-size: 0.68rem; font-weight: 900; text-transform: uppercase; }
    .error-block ul { display: grid; gap: 8px; list-style: none; margin: 10px 0 0; padding: 0; }
    .error-block li { display: grid; gap: 3px; }
    .error-block li span { color: #bcb1b3; font-size: 0.68rem; }
    .error-block code { font-size: 0.72rem; overflow-wrap: anywhere; white-space: pre-wrap; }
    .evidence-link { color: #245fbd; font-size: 0.8rem; font-weight: 800; width: fit-content; }
    .issue-empty { align-items: center; display: grid; gap: 10px; justify-items: start; padding: 22px; }
    .issue-empty p { color: #6d7b86; font-size: 0.85rem; margin: 0; }
    .analysis-panel { margin: 0 auto 20px; max-width: 1320px; }
    .analysis-source { border: 1px solid currentColor; border-radius: 4px; font-size: 0.66rem; font-weight: 900; padding: 5px 7px; text-transform: uppercase; }
    .analysis-source-ai { color: #245fbd; }
    .analysis-source-baseline { color: #8a651c; }
    .analysis-source-none { color: #6d7b86; }
    .analysis-content { display: grid; }
    .analysis-notice { background: #fff8e7; border-bottom: 1px solid #ecdcae; color: #71551b; font-size: 0.78rem; margin: 0; padding: 11px 20px; }
    .analysis-summary { align-items: start; display: grid; gap: 28px; grid-template-columns: minmax(0, 1fr) auto; padding: 22px 20px; }
    .analysis-summary p, .analysis-section p, .severity-reasoning p { color: #52616d; font-size: 0.86rem; line-height: 1.6; margin: 7px 0 0; }
    .analysis-label { color: #6d7b86; display: block; font-size: 0.68rem; font-weight: 900; text-transform: uppercase; }
    .severity-block { border-left: 3px solid currentColor; display: grid; gap: 3px; min-width: 112px; padding: 6px 0 6px 13px; }
    .severity-block span { color: #71808b; font-size: 0.66rem; font-weight: 800; text-transform: uppercase; }
    .severity-block strong { font-size: 1.05rem; }
    .severity-low { color: #187056; }
    .severity-medium { color: #9a6815; }
    .severity-high, .severity-critical { color: #b43632; }
    .analysis-columns { border-top: 1px solid #edf0f2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .analysis-section { padding: 20px; }
    .analysis-section + .analysis-section { border-left: 1px solid #edf0f2; }
    .analysis-section ol { color: #52616d; display: grid; font-size: 0.84rem; gap: 9px; line-height: 1.5; margin: 9px 0 0; padding-left: 20px; }
    .severity-reasoning { background: #f8fafb; border-top: 1px solid #edf0f2; padding: 17px 20px; }
    .analysis-empty { align-items: center; display: flex; gap: 13px; padding: 22px; }
    .analysis-empty strong { font-size: 0.88rem; }
    .analysis-empty p { color: #6d7b86; font-size: 0.82rem; margin: 4px 0 0; }
    .timeline-panel { margin: 0 auto 30px; max-width: 1320px; }
    .timeline { padding: 8px 20px 18px; }
    .timeline-event {
      display: grid;
      gap: 14px;
      grid-template-columns: 12px 76px minmax(0, 1fr);
      min-height: 76px;
      position: relative;
    }
    .timeline-event::before { background: #dfe5e9; content: ""; height: 100%; left: 5px; position: absolute; top: 18px; width: 2px; }
    .timeline-event:last-child::before { display: none; }
    .timeline-marker { background: #27876b; border: 3px solid white; box-shadow: 0 0 0 1px #aab8c1; height: 12px; margin-top: 18px; position: relative; width: 12px; z-index: 1; }
    .timeline-failed .timeline-marker { background: #d94b47; }
    .timeline-pending .timeline-marker { background: #c28a22; }
    .timeline-time { display: grid; gap: 2px; padding-top: 13px; }
    .timeline-time span { color: #6d7b86; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.68rem; }
    .timeline-time time { color: #93a0aa; font-size: 0.65rem; }
    .timeline-copy { border-bottom: 1px solid #edf0f2; min-width: 0; padding: 13px 0 16px; }
    .timeline-copy strong { font-size: 0.86rem; }
    .timeline-copy p { color: #6d7b86; font-size: 0.76rem; line-height: 1.45; margin: 5px 0 0; }
    .timeline-copy .timeline-error { color: #a62e2a; }
    .timeline-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .timeline-meta span { background: #eef2f4; border-radius: 4px; color: #53636f; font-size: 0.66rem; padding: 4px 6px; }
    .timeline-url { color: #7a8790; display: block; font-size: 0.68rem; margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .evidence-section { margin: 0 auto; max-width: 1320px; }
    .evidence-section > .section-heading { border: 0; padding-left: 0; padding-right: 0; }
    .screenshot-grid { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .screenshot-item { background: white; border: 1px solid #d6dde2; margin: 0; overflow: hidden; }
    .screenshot-item a { background: #e7ecef; display: block; aspect-ratio: 16 / 9; overflow: hidden; }
    .screenshot-item img { display: block; height: 100%; object-fit: contain; object-position: top; transition: transform 180ms ease; width: 100%; }
    .screenshot-item a:hover img { transform: scale(1.015); }
    .screenshot-item figcaption { align-items: center; display: flex; gap: 12px; justify-content: space-between; padding: 11px 13px; }
    .screenshot-item figcaption span { font-size: 0.76rem; font-weight: 800; }
    .screenshot-item figcaption code { color: #71808b; font-size: 0.66rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty-copy { color: #6d7b86; font-size: 0.86rem; padding: 20px; }
    .history-panel { margin: 0 auto; max-width: 1320px; }
    .history-table { min-width: 0; }
    .history-row {
      align-items: center;
      border-bottom: 1px solid #edf0f2;
      display: grid;
      gap: 18px;
      grid-template-columns: minmax(240px, 2fr) minmax(140px, 0.9fr) 105px 82px 88px 82px 90px;
      padding: 15px 20px;
    }
    .history-row:last-child { border-bottom: 0; }
    .history-table-head { background: #f8fafb; color: #6d7b86; font-size: 0.68rem; font-weight: 900; padding-bottom: 10px; padding-top: 10px; text-transform: uppercase; }
    .history-run { min-width: 0; }
    .history-run strong, .history-run code { display: block; }
    .history-run strong { font-size: 0.84rem; line-height: 1.4; }
    .history-run code { color: #84919a; font-size: 0.65rem; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .history-cell { color: #52616d; font-size: 0.76rem; min-width: 0; }
    .history-cell strong { color: #1c2733; font-size: 0.86rem; }
    .history-cell .status-tag { display: inline-block; font-size: 0.62rem; padding: 5px 6px; }
    .history-action a { color: #245fbd; font-size: 0.76rem; font-weight: 800; }
    .mobile-label { display: none; }
    .page-footer { border-top: 1px solid #d6dde2; color: #7a8790; display: flex; font-size: 0.7rem; justify-content: space-between; margin: 34px auto 0; max-width: 1320px; padding-top: 18px; }
    .empty-shell { align-items: center; display: grid; min-height: 100vh; }
    .empty-state { margin: 0 auto; max-width: 520px; text-align: center; }
    .empty-state .empty-mark { margin-bottom: 22px; }
    .empty-state h1 { margin: 8px auto 12px; }
    .empty-state p { color: #6d7b86; line-height: 1.55; }
    .empty-state code { background: #142029; border-radius: 4px; color: white; display: inline-block; margin-top: 12px; padding: 10px 13px; }
    .test-entry-shell { min-height: 100vh; }
    .test-entry-header { align-items: center; }
    .planner-status { border: 1px solid currentColor; border-radius: 4px; font-size: 0.7rem; font-weight: 900; padding: 7px 9px; text-transform: uppercase; }
    .planner-ready { color: #187056; }
    .planner-offline { color: #9a6815; }
    .test-form-panel { margin: 0 auto; max-width: 900px; }
    .test-request-form { display: grid; gap: 22px; padding: 24px; }
    .mode-fieldset { border: 0; margin: 0; min-width: 0; padding: 0; }
    .mode-fieldset legend { color: #53636f; font-size: 0.76rem; font-weight: 800; margin-bottom: 8px; }
    .mode-control { border: 1px solid #bcc7ce; border-radius: 6px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; }
    .execution-summary { padding: 0 20px 14px; }
    .mode-option { cursor: pointer; min-width: 0; position: relative; }
    .mode-option + .mode-option { border-left: 1px solid #bcc7ce; }
    .mode-option input { height: 1px; opacity: 0; position: absolute; width: 1px; }
    .mode-option span { color: #53636f; display: block; font-size: 0.76rem; font-weight: 800; overflow-wrap: anywhere; padding: 11px 8px; text-align: center; }
    .mode-option input:checked + span { background: #1c2733; color: white; }
    .mode-option input:focus-visible + span { box-shadow: inset 0 0 0 3px #8eb6ef; }
    .mode-disabled { cursor: not-allowed; }
    .mode-disabled span { background: #f0f2f3; color: #9aa5ac; }
    .field-group { display: grid; gap: 8px; }
    .field-group > span { color: #53636f; font-size: 0.76rem; font-weight: 800; }
    .field-group input, .field-group textarea { background: #fbfcfd; border: 1px solid #bcc7ce; color: #1c2733; outline: none; padding: 12px 13px; width: 100%; }
    .field-group textarea { line-height: 1.5; resize: vertical; }
    .field-group input:focus, .field-group textarea:focus { border-color: #245fbd; box-shadow: 0 0 0 3px #dce8fa; }
    .auth-configuration { border-bottom: 1px solid #e4e9ec; border-top: 1px solid #e4e9ec; display: grid; gap: 16px; padding: 18px 0; }
    .auth-heading { align-items: center; display: flex; gap: 18px; justify-content: space-between; }
    .auth-heading > div { display: grid; gap: 4px; }
    .auth-heading strong { font-size: 0.9rem; }
    .field-label { color: #71808b; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; }
    .auth-toggle { align-items: center; cursor: pointer; display: flex; font-size: 0.76rem; font-weight: 800; gap: 8px; }
    .auth-toggle input { accent-color: #245fbd; height: 16px; width: 16px; }
    .auth-fields { display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .auth-fields input:disabled { background: #f0f2f3; color: #87949d; cursor: not-allowed; }
    .auth-configuration > p { color: #6d7b86; font-size: 0.76rem; line-height: 1.5; margin: 0; }
    .form-error { background: #fff1ef; border-left: 3px solid #d94b47; color: #922f2b; font-size: 0.82rem; padding: 12px 13px; }
    .form-actions { align-items: center; border-top: 1px solid #edf0f2; display: flex; gap: 18px; justify-content: space-between; padding-top: 18px; }
    .form-actions span { color: #71808b; font-size: 0.74rem; line-height: 1.45; }
    .form-actions button, .primary-action, .secondary-action { border-radius: 5px; font-size: 0.8rem; font-weight: 900; padding: 11px 15px; text-decoration: none; }
    .form-actions button, .primary-action { background: #245fbd; border: 1px solid #245fbd; color: white; cursor: pointer; }
    .form-actions button:disabled { background: #9ba6ad; border-color: #9ba6ad; cursor: not-allowed; }
    .request-id { color: #71808b; font-size: 0.72rem; overflow-wrap: anywhere; }
    .request-status-panel { align-items: center; display: grid; gap: 18px; grid-template-columns: auto minmax(0, 1fr) auto; margin: 0 auto 20px; max-width: 900px; padding: 22px; }
    .request-status-mark { align-items: center; background: #1c2733; color: white; display: flex; font-size: 0.7rem; font-weight: 900; height: 40px; justify-content: center; width: 40px; }
    .request-status-copy h2 { margin-top: 5px; }
    .request-status-copy > p:last-child { color: #586875; font-size: 0.84rem; margin: 7px 0 0; }
    .request-status-tag { border: 1px solid currentColor; border-radius: 4px; color: #53636f; font-size: 0.68rem; font-weight: 900; padding: 6px 8px; text-transform: uppercase; }
    .request-running, .request-queued { border-left: 4px solid #c28a22; }
    .request-completed { border-left: 4px solid #27876b; }
    .request-failed { border-left: 4px solid #d94b47; }
    .request-result-failed { border-left-color: #d94b47; }
    .request-facts { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 0 auto; max-width: 900px; }
    .request-facts > div { border-right: 1px solid #edf0f2; display: grid; gap: 5px; padding: 18px; }
    .request-facts > div:last-child { border-right: 0; }
    .request-facts span { color: #71808b; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; }
    .request-facts strong { font-size: 0.82rem; line-height: 1.4; }
    .expected-behavior-panel { margin: 14px auto 0; max-width: 900px; padding: 18px; }
    .expected-behavior-panel span { color: #71808b; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; }
    .expected-behavior-panel p { color: #52616d; font-size: 0.86rem; line-height: 1.55; margin: 7px 0 0; }
    .request-actions { display: flex; gap: 10px; justify-content: flex-end; margin: 18px auto 0; max-width: 900px; }
    .secondary-action { background: white; border: 1px solid #bcc7ce; color: #33434f; }
    @media (max-width: 1040px) {
      .report-grid { grid-template-columns: 1fr; }
      .issue-panel { grid-row: 1; }
      .history-row { grid-template-columns: minmax(220px, 1.5fr) minmax(130px, 1fr) 100px 70px 80px 80px; }
      .history-row > :nth-child(5) { display: none; }
    }
    @media (max-width: 780px) {
      .run-context { grid-template-columns: 1fr; }
      .sidebar { height: auto; padding: 18px; position: static; width: 100%; }
      .section-nav { display: none; }
      .product-nav { grid-template-columns: repeat(4, minmax(0, 1fr)); padding-bottom: 12px; }
      .product-nav a { border-bottom: 3px solid transparent; border-left: 0; padding: 9px 7px; text-align: center; }
      .product-nav a.active { border-bottom-color: #f0c24b; border-left: 0; }
      .sidebar-note { margin-top: 0; }
      .main-content { margin-left: 0; padding: 24px 16px; }
      .report-header { align-items: start; display: grid; }
      .run-identity { justify-items: start; }
      .status-band { align-items: start; grid-template-columns: auto minmax(0, 1fr); }
      .status-tag { grid-column: 2; width: fit-content; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric:nth-child(2) { border-right: 0; }
      .metric:nth-child(-n + 2) { border-bottom: 1px solid #d6dde2; }
      .screenshot-grid { grid-template-columns: 1fr; }
      .analysis-columns { grid-template-columns: 1fr; }
      .analysis-section + .analysis-section { border-left: 0; border-top: 1px solid #edf0f2; }
      .history-table-head { display: none; }
      .history-row {
        align-items: start;
        gap: 16px 12px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        padding: 18px;
      }
      .history-row > :nth-child(5) { display: block; }
      .history-run, .history-action { grid-column: 1 / -1; }
      .history-cell { display: grid; gap: 4px; }
      .mobile-label { color: #89969f; display: block; font-size: 0.62rem; font-weight: 900; text-transform: uppercase; }
      .history-action { border-top: 1px solid #edf0f2; padding-top: 12px; }
      .request-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .request-facts > div { border-bottom: 1px solid #edf0f2; }
      .request-facts > div:nth-child(2n) { border-right: 0; }
      .request-facts > div:last-child { border-bottom: 0; grid-column: 1 / -1; }
    }
    @media (max-width: 480px) {
      .sidebar { gap: 18px; }
      .picker-row { grid-template-columns: 1fr; }
      h1 { font-size: 1.55rem; }
      .status-band { grid-template-columns: 1fr; }
      .status-tag { grid-column: 1; }
      .auth-fields { grid-template-columns: 1fr; }
      .form-actions { align-items: stretch; flex-direction: column; }
      .form-actions button { width: 100%; }
      .request-status-panel { grid-template-columns: 1fr; }
      .request-actions { display: grid; }
      .primary-action, .secondary-action { text-align: center; }
      .analysis-summary { grid-template-columns: 1fr; }
      .timeline-event { gap: 9px; grid-template-columns: 12px 55px minmax(0, 1fr); }
      .timeline-url { white-space: normal; overflow-wrap: anywhere; }
      .page-footer { display: grid; gap: 5px; }
    }
  `;
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function sentenceCase(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[character] ?? character;
  });
}
