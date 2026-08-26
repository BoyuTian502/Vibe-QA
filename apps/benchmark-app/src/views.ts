import type { ProjectRecord, WorkspaceSettings } from "./state.js";

export function renderLoginPage(): string {
  return renderPage({
    title: "VibeQA Benchmark Login",
    body: `
      <main class="auth-shell">
        <section class="auth-panel">
          <p class="eyebrow">Benchmark SaaS</p>
          <h1>Sign in to Acme Growth</h1>
          <p class="muted">Use the dedicated test account to access the workspace.</p>
          <form id="login-form">
            <label>Email
              <input name="email" type="email" autocomplete="username" value="qa@example.com" />
            </label>
            <label>Password
              <input name="password" type="password" autocomplete="current-password" value="password123" />
            </label>
            <button id="login-submit" type="submit">Sign in</button>
            <p id="login-message" role="status"></p>
          </form>
        </section>
      </main>
    `,
    script: `
      document.querySelector("#login-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const response = await fetch("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: form.get("email"),
            password: form.get("password")
          })
        });

        if (response.ok) {
          window.location.href = "/dashboard";
          return;
        }

        document.querySelector("#login-message").textContent = "Invalid benchmark credentials.";
      });
    `
  });
}

export function renderDashboardPage(projects: ProjectRecord[]): string {
  const projectCards = projects
    .map(
      (project) => `
        <article class="project-card" data-project-id="${escapeHtml(project.id)}">
          <div>
            <h2>${escapeHtml(project.name)}</h2>
            <p>${escapeHtml(project.description)}</p>
          </div>
          <dl>
            <div><dt>Status</dt><dd>${escapeHtml(project.status)}</dd></div>
            <div><dt>Owner</dt><dd>${escapeHtml(project.owner)}</dd></div>
          </dl>
          <nav class="row">
            <a href="/projects/${escapeHtml(project.id)}">Open</a>
            <button type="button" data-delete-project="${escapeHtml(project.id)}">Delete</button>
          </nav>
        </article>
      `
    )
    .join("");

  return renderAppPage({
    title: "Dashboard",
    activePath: "/dashboard",
    body: `
      <section class="page-heading">
        <div>
          <p class="eyebrow">Private dashboard</p>
          <h1>Acme Growth Workspace</h1>
          <p class="muted">Plan launches, track customer work, and keep release tasks moving.</p>
        </div>
        <button id="trigger-client-error" type="button">Refresh dashboard insights</button>
      </section>

      <section class="panel dashboard-views" aria-label="Workspace information">
        <div class="row" role="tablist" aria-label="Dashboard views">
          <button id="view-overview" type="button" role="tab" aria-selected="true">Overview</button>
          <button id="view-activity" type="button" role="tab" aria-selected="false">Activity</button>
          <button id="view-notifications" type="button" role="tab" aria-selected="false">Notifications</button>
          <button id="view-help" type="button">Help</button>
        </div>
        <div id="dashboard-view" aria-live="polite">
          <h2>Workspace overview</h2>
          <p>Two active customer workflows are ready for review.</p>
        </div>
      </section>

      <section class="layout-grid">
        <form id="create-project-form" class="panel">
          <h2>Create project</h2>
          <label>Project name
            <input name="name" placeholder="Example: Billing QA pass" />
          </label>
          <label>Description
            <textarea name="description" placeholder="What should the team accomplish?"></textarea>
          </label>
          <button type="submit">Create project</button>
          <p id="create-message" role="status"></p>
        </form>

        <section class="panel">
          <h2>Projects</h2>
          <div id="project-list" class="project-list">
            ${projectCards}
          </div>
        </section>
      </section>
    `,
    script: dashboardScript()
  });
}

export function renderProjectPage(project: ProjectRecord | null): string {
  if (!project) {
    return renderAppPage({
      title: "Project not found",
      activePath: "/dashboard",
      body: `
        <section class="page-heading">
          <h1>Project not found</h1>
          <a href="/dashboard">Back to dashboard</a>
        </section>
      `,
      script: ""
    });
  }

  return renderAppPage({
    title: project.name,
    activePath: "/dashboard",
    body: `
      <section class="page-heading">
        <div>
          <p class="eyebrow">Project detail</p>
          <h1>${escapeHtml(project.name)}</h1>
          <p class="muted">${escapeHtml(project.description)}</p>
        </div>
        <button id="sync-report" type="button" data-project-id="${escapeHtml(project.id)}">
          Sync billing report
        </button>
      </section>

      <form id="edit-project-form" class="panel" data-project-id="${escapeHtml(project.id)}">
        <h2>Edit project</h2>
        <label>Name
          <input name="name" value="${escapeAttribute(project.name)}" />
        </label>
        <label>Description
          <textarea name="description">${escapeHtml(project.description)}</textarea>
        </label>
        <label>Status
          <select name="status">
            <option value="active" ${project.status === "active" ? "selected" : ""}>Active</option>
            <option value="paused" ${project.status === "paused" ? "selected" : ""}>Paused</option>
          </select>
        </label>
        <button type="submit">Save changes</button>
        <p id="edit-message" role="status"></p>
      </form>
    `,
    script: projectScript()
  });
}

export function renderSettingsPage(settings: WorkspaceSettings): string {
  return renderAppPage({
    title: "Settings",
    activePath: "/settings",
    body: `
      <section class="page-heading">
        <div>
          <p class="eyebrow">Workspace settings</p>
          <h1>Settings</h1>
          <p class="muted">Adjust safe benchmark preferences for the local workspace.</p>
        </div>
      </section>

      <form id="settings-form" class="panel">
        <label>Workspace name
          <input name="workspaceName" value="${escapeAttribute(settings.workspaceName)}" />
        </label>
        <label>Default project status
          <select name="defaultProjectStatus">
            <option value="active" ${settings.defaultProjectStatus === "active" ? "selected" : ""}>Active</option>
            <option value="paused" ${settings.defaultProjectStatus === "paused" ? "selected" : ""}>Paused</option>
          </select>
        </label>
        <label class="checkbox">
          <input name="weeklyDigest" type="checkbox" ${settings.weeklyDigest ? "checked" : ""} />
          Send weekly digest
        </label>
        <button type="submit">Save settings</button>
        <p id="settings-message" role="status"></p>
      </form>
    `,
    script: settingsScript()
  });
}

export function renderNotFoundPage(): string {
  return renderPage({
    title: "Not found",
    body: `
      <main class="auth-shell">
        <section class="auth-panel">
          <h1>Page not found</h1>
          <a href="/dashboard">Go to dashboard</a>
        </section>
      </main>
    `,
    script: ""
  });
}

function renderAppPage(input: {
  title: string;
  activePath: string;
  body: string;
  script: string;
}): string {
  return renderPage({
    title: input.title,
    body: `
      <header class="topbar">
        <a class="brand" href="/dashboard">Acme Growth</a>
        <nav>
          <a ${input.activePath === "/dashboard" ? 'aria-current="page"' : ""} href="/dashboard">Dashboard</a>
          <a ${input.activePath === "/settings" ? 'aria-current="page"' : ""} href="/settings">Settings</a>
          <button id="logout-button" type="button">Log out</button>
        </nav>
      </header>
      <main class="app-shell">${input.body}</main>
    `,
    script: `${logoutScript()}${input.script}`
  });
}

function renderPage(input: { title: string; body: string; script: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)} - VibeQA Benchmark</title>
    <style>${styles()}</style>
  </head>
  <body>
    ${input.body}
    <script type="module">${input.script}</script>
  </body>
</html>`;
}

function dashboardScript(): string {
  return `
    const list = document.querySelector("#project-list");
    const dashboardView = document.querySelector("#dashboard-view");
    const dashboardTabs = ["overview", "activity", "notifications"];

    const dashboardViews = {
      overview: ["Workspace overview", "Two active customer workflows are ready for review."],
      activity: ["Recent workspace activity", "Launch checklist was reviewed by Morgan Lee."],
      notifications: ["Workspace notifications", "No urgent notifications require attention."],
      help: ["Workspace help", "Visit project details or settings to review a workflow."]
    };

    function showDashboardView(view) {
      const content = dashboardViews[view];
      dashboardView.innerHTML = "<h2>" + content[0] + "</h2><p>" + content[1] + "</p>";
      for (const tab of dashboardTabs) {
        document.querySelector("#view-" + tab).setAttribute(
          "aria-selected",
          String(tab === view)
        );
      }
    }

    for (const view of dashboardTabs) {
      document.querySelector("#view-" + view).addEventListener("click", () => {
        showDashboardView(view);
      });
    }
    document.querySelector("#view-help").addEventListener("click", () => {
      showDashboardView("help");
    });

    document.querySelector("#create-project-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          description: form.get("description")
        })
      });
      const project = await response.json();
      list.insertAdjacentHTML("afterbegin", projectCard(project));
      document.querySelector("#create-message").textContent = "Project created.";
      event.currentTarget.reset();
    });

    list.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-delete-project]");
      if (!button) return;
      const projectId = button.getAttribute("data-delete-project");
      const response = await fetch("/api/projects/" + projectId, { method: "DELETE" });
      if (response.ok) {
        button.closest("[data-project-id]").remove();
      }
    });

    document.querySelector("#trigger-client-error").addEventListener("click", () => {
      throw new Error("BUG-BENCH-005: fragile dashboard widget crashed");
    });

    function projectCard(project) {
      return \`
        <article class="project-card" data-project-id="\${project.id}">
          <div>
            <h2>\${escapeText(project.name)}</h2>
            <p>\${escapeText(project.description || "")}</p>
          </div>
          <dl>
            <div><dt>Status</dt><dd>\${escapeText(project.status)}</dd></div>
            <div><dt>Owner</dt><dd>\${escapeText(project.owner)}</dd></div>
          </dl>
          <nav class="row">
            <a href="/projects/\${project.id}">Open</a>
            <button type="button" data-delete-project="\${project.id}">Delete</button>
          </nav>
        </article>
      \`;
    }

    function escapeText(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[char]);
    }
  `;
}

function projectScript(): string {
  return `
    document.querySelector("#edit-project-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const projectId = event.currentTarget.getAttribute("data-project-id");
      const response = await fetch("/api/projects/" + projectId, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          description: form.get("description"),
          status: form.get("status")
        })
      });
      document.querySelector("#edit-message").textContent = response.ok
        ? "Project saved."
        : "Project could not be saved.";
    });

    document.querySelector("#sync-report").addEventListener("click", async (event) => {
      const projectId = event.currentTarget.getAttribute("data-project-id");
      const response = await fetch("/api/projects/" + projectId + "/sync-report", {
        method: "POST"
      });
      if (!response.ok) {
        document.querySelector("#edit-message").textContent = "Report sync failed.";
      }
    });
  `;
}

function settingsScript(): string {
  return `
    document.querySelector("#settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceName: form.get("workspaceName"),
          defaultProjectStatus: form.get("defaultProjectStatus"),
          weeklyDigest: form.get("weeklyDigest") === "on"
        })
      });
      document.querySelector("#settings-message").textContent = response.ok
        ? "Settings saved."
        : "Settings could not be saved.";
    });
  `;
}

function logoutScript(): string {
  return `
    document.querySelector("#logout-button")?.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      window.location.href = "/login";
    });
  `;
}

function styles(): string {
  return `
    :root {
      color: #1d2733;
      background: #f5f7fb;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    a { color: #1f5fbf; }
    button, input, textarea, select {
      border: 1px solid #b9c3d0;
      border-radius: 6px;
      font: inherit;
      padding: 10px 12px;
    }
    button {
      background: #1f5fbf;
      border-color: #1f5fbf;
      color: white;
      cursor: pointer;
      font-weight: 700;
    }
    label { display: grid; gap: 6px; font-weight: 700; }
    input, textarea, select { background: white; color: #1d2733; }
    textarea { min-height: 90px; resize: vertical; }
    .auth-shell {
      align-items: center;
      display: grid;
      min-height: 100vh;
      padding: 24px;
      place-items: center;
    }
    .auth-panel, .panel, .project-card {
      background: white;
      border: 1px solid #d8dee8;
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(31, 44, 60, 0.08);
    }
    .auth-panel {
      display: grid;
      gap: 18px;
      max-width: 430px;
      padding: 28px;
      width: 100%;
    }
    .auth-panel form, .panel { display: grid; gap: 16px; }
    .topbar {
      align-items: center;
      background: white;
      border-bottom: 1px solid #d8dee8;
      display: flex;
      justify-content: space-between;
      padding: 14px 28px;
    }
    .topbar nav, .row {
      align-items: center;
      display: flex;
      gap: 14px;
    }
    .brand {
      color: #1d2733;
      font-weight: 800;
      text-decoration: none;
    }
    .app-shell {
      display: grid;
      gap: 24px;
      margin: 0 auto;
      max-width: 1100px;
      padding: 28px;
    }
    .page-heading {
      align-items: end;
      display: flex;
      gap: 24px;
      justify-content: space-between;
    }
    .eyebrow {
      color: #64748b;
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0;
      margin: 0 0 6px;
      text-transform: uppercase;
    }
    h1, h2, p { margin-top: 0; }
    h1 { font-size: 2rem; margin-bottom: 8px; }
    h2 { font-size: 1.1rem; margin-bottom: 8px; }
    .muted { color: #64748b; }
    .layout-grid {
      align-items: start;
      display: grid;
      gap: 20px;
      grid-template-columns: minmax(280px, 360px) 1fr;
    }
    .panel, .project-card { padding: 18px; }
    .dashboard-views { gap: 12px; }
    .dashboard-views [role="tab"][aria-selected="false"],
    .dashboard-views #view-help {
      background: white;
      color: #1f5fbf;
    }
    .project-list { display: grid; gap: 14px; }
    .project-card {
      display: grid;
      gap: 12px;
    }
    dl {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin: 0;
    }
    dt { color: #64748b; font-size: 0.78rem; font-weight: 800; }
    dd { margin: 0; }
    .checkbox {
      align-items: center;
      display: flex;
      gap: 10px;
    }
    @media (max-width: 760px) {
      .layout-grid, .page-heading { display: grid; grid-template-columns: 1fr; }
      .topbar { align-items: start; display: grid; gap: 12px; }
      .topbar nav { flex-wrap: wrap; }
    }
  `;
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char] ?? char;
  });
}
