import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ReportStore } from "./report-store.js";
import { renderDashboardPage, renderHistoryPage } from "./view.js";

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  outputRoot?: string;
}

export interface DashboardServer {
  url: string;
  outputRoot: string;
  close(): Promise<void>;
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function startDashboardServer(
  options: DashboardServerOptions = {}
): Promise<DashboardServer> {
  const host = options.host ?? "127.0.0.1";
  const outputRoot = options.outputRoot ?? join(repositoryRoot, "run-output", "demo");
  const store = new ReportStore(outputRoot);
  const server = createServer((request, response) => {
    void handleRequest(request, response, store);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4173, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Dashboard server did not expose a TCP address.");
  }

  return {
    url: `http://${host}:${address.port}`,
    outputRoot,
    close: async () => await closeServer(server)
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: ReportStore
): Promise<void> {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://dashboard.local");
    if (request.method !== "GET") {
      sendText(response, "Method not allowed", 405);
      return;
    }

    if (requestUrl.pathname === "/health") {
      sendJson(response, { status: "ok" });
      return;
    }

    if (requestUrl.pathname === "/api/runs") {
      sendJson(response, await store.listRuns());
      return;
    }

    const apiRunMatch = /^\/api\/runs\/([^/]+)$/.exec(requestUrl.pathname);
    if (apiRunMatch?.[1]) {
      sendJson(response, await store.loadRun(decodeURIComponent(apiRunMatch[1])));
      return;
    }

    const artifactMatch = /^\/artifacts\/([^/]+)\/(.+)$/.exec(requestUrl.pathname);
    if (artifactMatch?.[1] && artifactMatch[2]) {
      const runId = decodeURIComponent(artifactMatch[1]);
      const relativePath = artifactMatch[2]
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/");
      const artifactPath = store.resolveArtifact(runId, relativePath);
      sendArtifact(response, artifactPath, await readFile(artifactPath));
      return;
    }

    if (requestUrl.pathname === "/history") {
      sendHtml(response, renderHistoryPage(await store.listRuns()));
      return;
    }

    if (requestUrl.pathname === "/runs") {
      const runs = await store.listRuns();
      const selectedId = requestUrl.searchParams.get("run");
      const selectedRun =
        (selectedId ? runs.find((run) => run.id === selectedId) : null) ??
        runs[0] ??
        null;
      sendRedirect(
        response,
        selectedRun ? `/runs/${encodeURIComponent(selectedRun.id)}` : "/"
      );
      return;
    }

    const detailMatch = /^\/runs\/([^/]+)$/.exec(requestUrl.pathname);
    if (detailMatch?.[1]) {
      const runId = decodeURIComponent(detailMatch[1]);
      const runs = await store.listRuns();
      const selectedRun = runs.find((run) => run.id === runId) ?? null;
      if (!selectedRun) {
        sendText(response, "Run not found", 404);
        return;
      }
      sendHtml(response, renderDashboardPage(runs, selectedRun, "details"));
      return;
    }

    if (requestUrl.pathname === "/") {
      const runs = await store.listRuns();
      const selectedId = requestUrl.searchParams.get("run") ?? runs[0]?.id ?? null;
      const selectedRun =
        (selectedId ? runs.find((run) => run.id === selectedId) : null) ??
        runs[0] ??
        null;
      sendHtml(
        response,
        renderDashboardPage(
          runs,
          selectedRun,
          requestUrl.searchParams.has("run") ? "details" : "dashboard"
        )
      );
      return;
    }

    sendText(response, "Not found", 404);
  } catch (error) {
    const statusCode = isNotFoundError(error) ? 404 : 500;
    sendJson(
      response,
      { error: error instanceof Error ? error.message : "Unexpected dashboard error" },
      statusCode
    );
  }
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff"
  });
  response.end(html);
}

function sendJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, body: string, statusCode: number): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end();
}

function sendArtifact(response: ServerResponse, path: string, body: Buffer): void {
  response.writeHead(200, {
    "content-type": contentTypeFor(path),
    "cache-control": "private, max-age=60",
    "content-length": body.byteLength,
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
