import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startBenchmarkServer, type BenchmarkServer } from "../src/index.js";

interface JsonResponse<T> {
  response: Response;
  body: T;
}

let app: BenchmarkServer;

beforeEach(async () => {
  app = await startBenchmarkServer();
  app.reset();
});

afterEach(async () => {
  await app.close();
});

describe("benchmark SaaS app seeded bugs", () => {
  it("BUG-BENCH-001 returns a created project but loses it after refresh data reload", async () => {
    const created = await jsonRequest<ProjectPayload>(`${app.url}/api/projects`, {
      method: "POST",
      body: {
        name: "Regression persistence check",
        description: "This project should disappear after reload."
      }
    });

    expect(created.response.status).toBe(201);
    expect(created.body.name).toBe("Regression persistence check");

    const reloaded = await jsonRequest<{ projects: ProjectPayload[] }>(
      `${app.url}/api/projects`
    );

    expect(reloaded.body.projects.map((project) => project.name)).not.toContain(
      "Regression persistence check"
    );
  });

  it("BUG-BENCH-002 serves private dashboard content after logout", async () => {
    const login = await fetch(`${app.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "qa@example.com", password: "password123" })
    });
    expect(login.status).toBe(200);

    const logout = await fetch(`${app.url}/api/logout`, { method: "POST" });
    expect(logout.status).toBe(200);

    const dashboard = await fetch(`${app.url}/dashboard`);
    const html = await dashboard.text();

    expect(dashboard.status).toBe(200);
    expect(html).toContain("Private dashboard");
    expect(html).toContain("Acme Growth Workspace");
  });

  it("BUG-BENCH-003 accepts whitespace-only project names", async () => {
    const created = await jsonRequest<ProjectPayload>(`${app.url}/api/projects`, {
      method: "POST",
      body: {
        name: "   ",
        description: "Whitespace should have been rejected."
      }
    });

    expect(created.response.status).toBe(201);
    expect(created.body.name).toBe("   ");
  });

  it("BUG-BENCH-004 returns HTTP 500 for the designated sync action", async () => {
    const response = await fetch(`${app.url}/api/projects/proj-alpha/sync-report`, {
      method: "POST"
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe("Billing report sync failed");
  });

  it("BUG-BENCH-005 exposes a deterministic uncaught client exception trigger", async () => {
    const dashboard = await fetch(`${app.url}/dashboard`);
    const html = await dashboard.text();

    expect(dashboard.status).toBe(200);
    expect(html).toContain("trigger-client-error");
    expect(html).toContain("BUG-BENCH-005: fragile dashboard widget crashed");
    expect(html).toContain("throw new Error");
  });
});

describe("benchmark SaaS app required workflows", () => {
  it("supports edit, delete, settings, navigation, and resettable local data", async () => {
    const edited = await jsonRequest<ProjectPayload>(
      `${app.url}/api/projects/proj-alpha`,
      {
        method: "PUT",
        body: {
          name: "Launch checklist updated",
          description: "Updated deterministic project.",
          status: "paused"
        }
      }
    );
    expect(edited.response.status).toBe(200);
    expect(edited.body.name).toBe("Launch checklist updated");
    expect(edited.body.status).toBe("paused");

    const deleted = await jsonRequest<{ deleted: boolean }>(
      `${app.url}/api/projects/proj-beta`,
      {
        method: "DELETE"
      }
    );
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);

    const settings = await jsonRequest<SettingsPayload>(`${app.url}/api/settings`, {
      method: "PUT",
      body: {
        workspaceName: "Updated Workspace",
        weeklyDigest: false,
        defaultProjectStatus: "paused"
      }
    });
    expect(settings.response.status).toBe(200);
    expect(settings.body.workspaceName).toBe("Updated Workspace");

    const settingsPage = await fetch(`${app.url}/settings`);
    expect(await settingsPage.text()).toContain("Updated Workspace");

    const projectPage = await fetch(`${app.url}/projects/proj-alpha`);
    expect(await projectPage.text()).toContain("Launch checklist updated");

    await fetch(`${app.url}/api/reset`, { method: "POST" });
    const resetProjects = await jsonRequest<{ projects: ProjectPayload[] }>(
      `${app.url}/api/projects`
    );

    expect(resetProjects.body.projects.map((project) => project.name)).toEqual([
      "Launch checklist",
      "Customer onboarding"
    ]);
  });
});

async function jsonRequest<T>(
  url: string,
  init: { method?: string; body?: unknown } = {}
): Promise<JsonResponse<T>> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers:
      init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });

  return {
    response,
    body: (await response.json()) as T
  };
}

interface ProjectPayload {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused";
  owner: string;
  updatedAt: string;
}

interface SettingsPayload {
  workspaceName: string;
  weeklyDigest: boolean;
  defaultProjectStatus: "active" | "paused";
}
