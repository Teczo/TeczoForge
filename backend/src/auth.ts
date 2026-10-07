import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { getUsersCollection, safeMessage } from "./db.js";

// Team login (FRG-16): usernames and passwords stored in MongoDB.
//
// Passwords are never stored. We store a "scrypt" hash: a scrambled version that cannot be turned
// back into the password. scrypt is built into Node.js, so no extra package is needed.
//
// After login the browser gets a cookie with the username and an end date, signed with
// SESSION_SECRET from backend/.env. The backend checks the signature on every request, without
// asking MongoDB. So people who are logged in can keep working when MongoDB is offline.

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const COOKIE_NAME = "teczoforge_session";
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const MIN_PASSWORD_LENGTH = 8;

// The key that signs session cookies. Make one with `npm run secret`.
// Without SESSION_SECRET, a new random key is made at every start, which logs everybody out when
// the backend restarts. A SESSION_SECRET that is set but too short is refused: the backend stops.
const MIN_SESSION_SECRET_LENGTH = 32;
let sessionSecret = "";
export function checkSessionSecret() {
  sessionSecret = process.env.SESSION_SECRET ?? "";
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("hex");
    console.warn(
      "Warning: SESSION_SECRET is not set in backend/.env, so everyone is logged out when the backend restarts. Run `npm run secret` to make one.",
    );
    return;
  }
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    console.error(
      `Error: SESSION_SECRET in backend/.env is too short (${sessionSecret.length} characters, needs at least ${MIN_SESSION_SECRET_LENGTH}). Run \`npm run secret\` and paste the new value.`,
    );
    process.exit(1);
  }
}

// ---- Passwords ----

// Make the hash to store, as "scrypt$<salt>$<hash>".
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [method, saltHex, hashHex] = stored.split("$");
  if (method !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

// ---- Session cookie ----

function sign(payload: string): string {
  if (!sessionSecret) checkSessionSecret();
  return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

// The cookie value: "<username and end date, base64>.<signature>".
function makeSessionValue(username: string): string {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

// The username in a valid, unexpired cookie, or null.
function readSessionValue(value: string | undefined): string | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof u !== "string" || typeof exp !== "number" || exp < Date.now()) return null;
    return u;
  } catch {
    return null;
  }
}

// Read one cookie from the Cookie header (no extra package needed).
function getCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

// HttpOnly: page scripts cannot read it. SameSite=Lax: other websites cannot use it.
function setSessionCookie(res: Response, value: string, maxAgeMs: number) {
  res.cookie(COOKIE_NAME, value, { httpOnly: true, sameSite: "lax", path: "/", maxAge: maxAgeMs });
}

// ---- Express ----

// Every /api request needs a login, except logging in itself.
// The logged-in username is put in res.locals.username for the routes.
export function requireLogin(req: Request, res: Response, next: NextFunction) {
  const username = readSessionValue(getCookie(req, COOKIE_NAME));
  if (!username) {
    res.status(401).json({ error: "You are not logged in. Refresh the page and log in." });
    return;
  }
  res.locals.username = username;
  next();
}

// POST /api/login  Body: { "username": "...", "password": "..." }
export async function loginHandler(req: Request, res: Response) {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string" || username === "" || password === "") {
    res.status(400).json({ error: "Enter your username and password." });
    return;
  }
  const name = username.trim().toLowerCase();

  let user;
  try {
    const users = await getUsersCollection();
    user = await users.findOne({ username: name });
  } catch (error) {
    console.warn(`Warning: login not possible. ${safeMessage(error)}`);
    res.status(503).json({ error: "Logging in is not possible right now because MongoDB cannot be reached." });
    return;
  }

  // Same answer for an unknown user and a wrong password, so nobody can find out which usernames exist.
  if (!user || !(await passwordMatches(password, user.passwordHash))) {
    res.status(401).json({ error: "Wrong username or password." });
    return;
  }

  setSessionCookie(res, makeSessionValue(user.username), SESSION_MS);
  res.json({ username: user.username });
}

// POST /api/logout
export function logoutHandler(_req: Request, res: Response) {
  setSessionCookie(res, "", 0);
  res.json({ ok: true });
}

// GET /api/me  Who is logged in (needs a login, so it answers 401 when nobody is).
export function meHandler(_req: Request, res: Response) {
  res.json({ username: res.locals.username });
}
