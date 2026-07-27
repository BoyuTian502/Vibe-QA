export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused";
  owner: string;
  updatedAt: string;
}

export interface WorkspaceSettings {
  workspaceName: string;
  weeklyDigest: boolean;
  defaultProjectStatus: "active" | "paused";
}

export interface BenchmarkData {
  projects: ProjectRecord[];
  settings: WorkspaceSettings;
}

export interface NewProjectInput {
  name: string;
  description?: string;
}

const initialData: BenchmarkData = {
  projects: [
    {
      id: "proj-alpha",
      name: "Launch checklist",
      description: "Track release readiness for the marketing launch.",
      status: "active",
      owner: "qa@example.com",
      updatedAt: "2026-07-01T09:00:00.000Z"
    },
    {
      id: "proj-beta",
      name: "Customer onboarding",
      description: "Improve the first-run workspace setup flow.",
      status: "paused",
      owner: "qa@example.com",
      updatedAt: "2026-07-02T09:00:00.000Z"
    }
  ],
  settings: {
    workspaceName: "Acme Growth Workspace",
    weeklyDigest: true,
    defaultProjectStatus: "active"
  }
};

let currentData = cloneData(initialData);
let nextProjectNumber = 100;

export function resetBenchmarkData(): BenchmarkData {
  currentData = cloneData(initialData);
  nextProjectNumber = 100;
  return getBenchmarkData();
}

export function getBenchmarkData(): BenchmarkData {
  return cloneData(currentData);
}

export function listProjects(): ProjectRecord[] {
  return currentData.projects.map((project) => ({ ...project }));
}

export function getProject(projectId: string): ProjectRecord | null {
  const project = currentData.projects.find((candidate) => candidate.id === projectId);
  return project ? { ...project } : null;
}

export function createProject(input: NewProjectInput): ProjectRecord {
  const now = "2026-07-27T09:00:00.000Z";
  const project: ProjectRecord = {
    id: `proj-created-${nextProjectNumber}`,
    name: input.name,
    description: input.description ?? "",
    status: currentData.settings.defaultProjectStatus,
    owner: "qa@example.com",
    updatedAt: now
  };

  nextProjectNumber += 1;

  // BUG-BENCH-001: created projects are returned to the UI but are not persisted.
  // BUG-BENCH-003: whitespace-only project names are accepted as valid input.
  return project;
}

export function updateProject(
  projectId: string,
  input: Partial<Pick<ProjectRecord, "name" | "description" | "status">>
): ProjectRecord | null {
  const project = currentData.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    return null;
  }

  project.name = input.name ?? project.name;
  project.description = input.description ?? project.description;
  project.status = input.status ?? project.status;
  project.updatedAt = "2026-07-27T10:00:00.000Z";

  return { ...project };
}

export function deleteProject(projectId: string): boolean {
  const previousLength = currentData.projects.length;
  currentData.projects = currentData.projects.filter(
    (project) => project.id !== projectId
  );
  return currentData.projects.length !== previousLength;
}

export function getSettings(): WorkspaceSettings {
  return { ...currentData.settings };
}

export function updateSettings(input: Partial<WorkspaceSettings>): WorkspaceSettings {
  currentData.settings = {
    ...currentData.settings,
    ...input
  };
  return getSettings();
}

function cloneData(data: BenchmarkData): BenchmarkData {
  return {
    projects: data.projects.map((project) => ({ ...project })),
    settings: { ...data.settings }
  };
}
