import type { Request, Response } from "express";
import type { Collection } from "mongodb";
import { HttpError } from "./httpError.js";
import { findJob, getProjectsCollection, getUnsortedProjectId, PROJECT_NAME_COLLATION, safeMessage, UNSORTED_PROJECT_NAME } from "./db.js";
import type { Project } from "./db.js";
import { JOB_ID_PATTERN, sendError } from "./jobs.js";

// Projects (FRG-39).
// A project is a named container for jobs, board cards and chats.
// There are no roles: everyone on the team can see, add, rename and archive every project.
// Projects are never deleted, only archived. "Unsorted" always exists and cannot be changed.
// Projects live in MongoDB only. When MongoDB is offline these routes answer 503.

const MAX_NAME_LENGTH = 60;

const OFFLINE_MESSAGE = "Projects are not available because MongoDB cannot be reached.";

// MongoDB's error code when a unique index says no (here: the name is already used).
const DUPLICATE_KEY = 11000;

// Run work on the projects collection. If MongoDB cannot be reached, throw the clear 503 message.
async function withProjects<T>(work: (projects: Collection<Project>) => Promise<T>): Promise<T> {
  try {
    return await work(await getProjectsCollection());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isDuplicateName(error)) throw new HttpError(400, "A project with this name already exists.");
    console.warn(`Warning: projects could not use MongoDB. ${safeMessage(error)}`);
    throw new HttpError(503, OFFLINE_MESSAGE);
  }
}

function isDuplicateName(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY;
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new HttpError(400, "A project needs a name.");
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    throw new HttpError(400, `The name is too long. Maximum is ${MAX_NAME_LENGTH} characters.`);
  }
  return name.trim();
}

function checkId(req: Request): string {
  const id = String(req.params.id);
  if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not a project id.");
  return id;
}

// ---- The project of a new job or card (FRG-40) ----

// Check a projectId sent with a new job or card, and return the id to save.
// No projectId: "Unsorted". An unknown or archived project: 400.
export async function checkProjectId(projectId: unknown): Promise<string> {
  if (projectId === undefined || projectId === null) {
    return await withProjects(() => getUnsortedProjectId());
  }
  if (typeof projectId !== "string" || !JOB_ID_PATTERN.test(projectId)) {
    throw new HttpError(400, "projectId must be a project id.");
  }
  const project = await withProjects((p) => p.findOne({ id: projectId }));
  if (!project) throw new HttpError(400, "There is no project with this id.");
  if (project.archived) throw new HttpError(400, `The project "${project.name}" is archived. Choose another project.`);
  return projectId;
}

// The project of a new job or card. "Send to" (FRG-26): a job or card made from another
// job's result goes into the same project as that job, whatever projectId was sent.
// Otherwise the projectId that was sent is checked (see checkProjectId).
export async function projectForNewItem(projectId: unknown, sourceJobId?: string): Promise<string> {
  if (sourceJobId) {
    const source = await findJob(sourceJobId);
    if (source?.projectId) {
      const project = await withProjects((p) => p.findOne({ id: source.projectId }));
      if (project?.archived) {
        throw new HttpError(400, `The picture comes from the project "${project.name}", which is archived.`);
      }
      if (project) return project.id;
    }
  }
  return await checkProjectId(projectId);
}

// GET /api/projects
// Answer: { "projects": [...] }: every project that is not archived, sorted by name
// (capital letters do not matter). "Unsorted" is never archived, so it is always in the list.
export async function listProjectsHandler(_req: Request, res: Response) {
  try {
    const projects = await withProjects((p) =>
      p
        .find({ archived: false }, { projection: { _id: 0 }, collation: PROJECT_NAME_COLLATION })
        .sort({ name: 1 })
        .toArray(),
    );
    res.json({ projects });
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/projects
// Body: { "name": "..." }. Answer: the new project.
// A name that is already used (also by an archived project, and not counting capital letters) answers 400.
export async function createProjectHandler(req: Request, res: Response) {
  try {
    const now = new Date();
    const project: Project = {
      id: crypto.randomUUID(),
      name: checkName(req.body?.name),
      createdBy: res.locals.username ?? null, // Set by requireLogin in auth.ts.
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    // The unique index on name stops a duplicate, even when two people add the same name at once.
    await withProjects((p) => p.insertOne({ ...project })); // A copy: insertOne adds MongoDB's own _id to what it gets.
    res.status(201).json(project);
  } catch (error) {
    sendError(res, error);
  }
}

// PATCH /api/projects/<id>
// Body: any of { "name", "archived" }. Rename a project, or archive it (archived: true) or bring it back (false).
// "Unsorted" cannot be changed (400).
export async function updateProjectHandler(req: Request, res: Response) {
  try {
    const id = checkId(req);
    const { name, archived } = req.body ?? {};
    const fields: Partial<Project> = {};
    if (name !== undefined) fields.name = checkName(name);
    if (archived !== undefined) {
      if (typeof archived !== "boolean") throw new HttpError(400, "archived must be true or false.");
      fields.archived = archived;
    }
    if (Object.keys(fields).length === 0) {
      throw new HttpError(400, "Send a name or archived to change.");
    }

    const project = await withProjects((p) => p.findOne({ id }, { projection: { _id: 0 } }));
    if (!project) throw new HttpError(404, "There is no project with this id.");
    if (project.name === UNSORTED_PROJECT_NAME) {
      throw new HttpError(400, `"${UNSORTED_PROJECT_NAME}" cannot be renamed or archived.`);
    }

    const updated = await withProjects((p) =>
      p.findOneAndUpdate(
        { id },
        { $set: { ...fields, updatedAt: new Date() } },
        { returnDocument: "after", projection: { _id: 0 } },
      ),
    );
    if (!updated) throw new HttpError(404, "There is no project with this id.");
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
}
