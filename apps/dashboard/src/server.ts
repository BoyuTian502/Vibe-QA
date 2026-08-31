import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LLMClient } from "@vibeqa/llm";

import {
  BugAnalysisService,
  createAnalysisClientFromEnvironment
} from "./bug-analysis.js";
import { ReportStore } from "./report-store.js";
import {
  createUserTestWorkflow,
  TestRequestValidationError,
  TestWorkflowUnavailableError,
  type CreateTestRequestInput,
  type QATestMode,
  type UserTestWorkflow
} from "./test-workflow.js";
import { TemporaryLoginCredentials } from "./secure-credentials.js";
import {
  renderDashboardPage,
  AUTHENTICATION_FORM_SCRIPT,
  renderHistoryPage,
  renderTestCreationPage,
  renderUnavailablePage,
  renderTestRequestPage
} from "./view.js";

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  outputRoot?: string;
  llmClient?: LLMClient | null;
  testWorkflow?: UserTestWorkflow;
}

export interface DashboardServer {
  url: string;
  outputRoot: string;
  close(): Promise<void>;
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const authenticationScriptHash = createHash("sha256")
  .update(AUTHENTICATION_FORM_SCRIPT)
  .digest("base64");

export async function startDashboardServer(
  options: DashboardServerOptions = {}
): Promise<DashboardServer> {
  const host = options.host ?? "127.0.0.1";
  const outputRoot = options.outputRoot ?? join(repositoryRoot, "run-output", "demo");
  const store = new ReportStore(outputRoot);
  const llmClient =
    options.llmClient === undefined
      ? createAnalysisClientFromEnvironment()
      : options.llmClient;
  const analysisService = new BugAnalysisService(llmClient);
  const testWorkflow = options.testWorkflow ?? createUserTestWorkflow(null, outputRoot);
  const server = createServer((request, response) => {
    void handleRequest(request, response, store, analysisService, testWorkflow);
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
  store: ReportStore,
  analysisService: BugAnalysisService,
  testWorkflow: UserTestWorkflow
): Promise<void> {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://dashboard.local");

    if (request.method === "POST" && requestUrl.pathname === "/tests") {
      const runs = await store.listRuns();
      let form: CreateTestRequestInput | null = null;
      try {
        form = await readTestRequestForm(request);
        const testRequest = testWorkflow.submit(form);
        sendRedirect(
          response,
          `/test-requests/${encodeURIComponent(testRequest.id)}`,
          303
        );
      } catch (error) {
        if (
          error instanceof TestRequestValidationError ||
          error instanceof TestWorkflowUnavailableError
        ) {
          sendHtml(
            response,
            renderTestCreationPage(
              runs,
              testWorkflow.availableModes,
              error.message,
              form
            ),
            error instanceof TestWorkflowUnavailableError ? 503 : 400
          );
          return;
        }
        throw error;
      }
      return;
    }

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

    const apiRequestMatch = /^\/api\/test-requests\/([^/]+)$/.exec(requestUrl.pathname);
    if (apiRequestMatch?.[1]) {
      const testRequest = testWorkflow.get(decodeURIComponent(apiRequestMatch[1]));
      if (!testRequest) {
        sendText(response, "Test request not found", 404);
        return;
      }
      sendJson(response, testRequest);
      return;
    }

    const analysisMatch = /^\/api\/runs\/([^/]+)\/analysis$/.exec(requestUrl.pathname);
    if (analysisMatch?.[1]) {
      const run = await store.loadRun(decodeURIComponent(analysisMatch[1]));
      sendJson(response, await analysisService.analyze(run));
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

    if (requestUrl.pathname === "/tests/new") {
      sendHtml(
        response,
        renderTestCreationPage(await store.listRuns(), testWorkflow.availableModes)
      );
      return;
    }

    const testRequestMatch = /^\/test-requests\/([^/]+)$/.exec(requestUrl.pathname);
    if (testRequestMatch?.[1]) {
      const runs = await store.listRuns();
      const testRequest = testWorkflow.get(decodeURIComponent(testRequestMatch[1]));
      if (!testRequest) {
        sendText(response, "Test request not found", 404);
        return;
      }
      sendHtml(response, renderTestRequestPage(runs, testRequest));
      return;
    }

    if (requestUrl.pathname === "/runs") {
      const runs = await store.listRuns();
      const selectedId = requestUrl.searchParams.get("run");
      const selectedRun =
        (selectedId ? runs.find((run) => run.id === selectedId) : null) ??
        runs[0] ??
        null;
      if (selectedId && !runs.some((run) => run.id === selectedId)) {
        sendHtml(response, renderUnavailablePage(), 404);
        return;
      }
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
        sendHtml(response, renderUnavailablePage(), 404);
        return;
      }
      sendHtml(
        response,
        renderDashboardPage(
          runs,
          selectedRun,
          "details",
          await analysisService.analyze(selectedRun)
        )
      );
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
          requestUrl.searchParams.has("run") ? "details" : "dashboard",
          selectedRun ? await analysisService.analyze(selectedRun) : null
        )
      );
      return;
    }

    sendText(response, "Not found", 404);
  } catch (error) {
    const statusCode = isNotFoundError(error) ? 404 : 500;
    if (request.method === "GET" && request.url?.startsWith("/runs/")) {
      sendHtml(response, renderUnavailablePage(), statusCode);
      return;
    }
    sendJson(
      response,
      { error: error instanceof Error ? error.message : "Unexpected dashboard error" },
      statusCode
    );
  }
}

function sendHtml(response: ServerResponse, html: string, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; script-src 'sha256-${authenticationScriptHash}'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`,
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

function sendRedirect(
  response: ServerResponse,
  location: string,
  statusCode = 302
): void {
  response.writeHead(statusCode, {
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

async function readTestRequestForm(request: IncomingMessage): Promise<{
  websiteUrl: string;
  objective: string;
  expectedBehavior: string;
  mode: "functional" | "exploratory" | "regression";
  credentials: TemporaryLoginCredentials | null;
}> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16_384) {
      throw new TestRequestValidationError("Test request is too large.");
    }
    chunks.push(buffer);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if (form.getAll("mode").length !== 1) {
    throw new TestRequestValidationError("Select exactly one testing mode.");
  }
  const mode = form.get("mode") ?? "";
  const loginRequired = form.get("loginRequired") === "on";
  const username = form.get("loginUsername") ?? "";
  const password = form.get("loginPassword") ?? "";
  let credentials: TemporaryLoginCredentials | null = null;
  if (loginRequired) {
    try {
      credentials = new TemporaryLoginCredentials(username, password);
    } catch (error) {
      throw new TestRequestValidationError(
        error instanceof Error
          ? error.message
          : "Temporary login credentials are invalid."
      );
    }
  }
  return {
    websiteUrl: form.get("websiteUrl") ?? "",
    objective: form.get("objective") ?? "",
    expectedBehavior: form.get("expectedBehavior") ?? "",
    mode: mode as QATestMode,
    credentials
  };
}
