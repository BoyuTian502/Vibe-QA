import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { fileURLToPath } from "node:url";

import {
  createProject,
  deleteProject,
  getProject,
  getSettings,
  listProjects,
  resetBenchmarkData,
  updateProject,
  updateSettings
} from "./state.js";
import {
  renderDashboardPage,
  renderLoginPage,
  renderNotFoundPage,
  renderProjectPage,
  renderSettingsPage
} from "./views.js";

export interface BenchmarkServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
  reset: () => void;
}

export interface StartBenchmarkServerOptions {
  port?: number;
  host?: string;
}

const testAccount = {
  email: "qa@example.com",
  password: "password123"
};

export async function startBenchmarkServer(
  options: StartBenchmarkServerOptions = {}
): Promise<BenchmarkServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer(handleRequest);

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, host, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Benchmark server did not bind to a TCP address.");
  }

  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeIdleConnections();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    reset: () => {
      resetBenchmarkData();
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://benchmark.local");

    if (
      request.method === "GET" &&
      (requestUrl.pathname === "/" || requestUrl.pathname === "/login")
    ) {
      sendHtml(response, renderLoginPage());
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/dashboard") {
      // BUG-BENCH-002: the dashboard is served even after logout or without a session.
      sendHtml(response, renderDashboardPage(listProjects()));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/projects/")) {
      const projectId = requestUrl.pathname.split("/")[2] ?? "";
      sendHtml(response, renderProjectPage(getProject(projectId)));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/settings") {
      sendHtml(response, renderSettingsPage(getSettings()));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/login") {
      const body = await readJsonBody(request);
      if (body.email === testAccount.email && body.password === testAccount.password) {
        response.setHeader("set-cookie", "vibeqa_session=valid; Path=/; SameSite=Lax");
        sendJson(response, { ok: true });
        return;
      }

      sendJson(response, { error: "Invalid credentials" }, 401);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/logout") {
      response.setHeader(
        "set-cookie",
        "vibeqa_session=; Path=/; Max-Age=0; SameSite=Lax"
      );
      sendJson(response, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/reset") {
      resetBenchmarkData();
      sendJson(response, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/projects") {
      sendJson(response, { projects: listProjects() });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/projects") {
      const body = await readJsonBody(request);
      const project = createProject({
        name: String(body.name ?? ""),
        description: String(body.description ?? "")
      });
      sendJson(response, project, 201);
      return;
    }

    const projectMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && request.method === "PUT") {
      const body = await readJsonBody(request);
      const project = updateProject(projectMatch[1] ?? "", {
        name: typeof body.name === "string" ? body.name : undefined,
        description:
          typeof body.description === "string" ? body.description : undefined,
        status:
          body.status === "active" || body.status === "paused" ? body.status : undefined
      });

      if (!project) {
        sendJson(response, { error: "Project not found" }, 404);
        return;
      }

      sendJson(response, project);
      return;
    }

    if (projectMatch && request.method === "DELETE") {
      const deleted = deleteProject(projectMatch[1] ?? "");
      sendJson(response, { deleted });
      return;
    }

    const syncMatch = requestUrl.pathname.match(
      /^\/api\/projects\/([^/]+)\/sync-report$/
    );
    if (syncMatch && request.method === "POST") {
      // BUG-BENCH-004: this designated valid action always returns HTTP 500.
      sendJson(response, { error: "Billing report sync failed" }, 500);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/settings") {
      sendJson(response, getSettings());
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/api/settings") {
      const body = await readJsonBody(request);
      const settings = updateSettings({
        workspaceName:
          typeof body.workspaceName === "string" ? body.workspaceName : undefined,
        weeklyDigest:
          typeof body.weeklyDigest === "boolean" ? body.weeklyDigest : undefined,
        defaultProjectStatus:
          body.defaultProjectStatus === "active" ||
          body.defaultProjectStatus === "paused"
            ? body.defaultProjectStatus
            : undefined
      });
      sendJson(response, settings);
      return;
    }

    sendHtml(response, renderNotFoundPage(), 404);
  } catch (error) {
    sendJson(
      response,
      { error: error instanceof Error ? error.message : "Unexpected error" },
      500
    );
  }
}

async function readJsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendHtml(response: ServerResponse, html: string, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close"
  });
  response.end(html);
}

function sendJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close"
  });
  response.end(JSON.stringify(body));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "3000");
  const server = await startBenchmarkServer({ port, host: "127.0.0.1" });
  console.log(`VibeQA benchmark app running at ${server.url}`);
}
