import { randomBytes } from "node:crypto";

// Print a new SESSION_SECRET (64 hex characters). Copy it into backend/.env.
//   cd backend
//   npm run secret
// Nothing is saved. Each run prints a different value.

console.log(randomBytes(32).toString("hex"));
