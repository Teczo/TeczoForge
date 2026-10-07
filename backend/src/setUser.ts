import "dotenv/config";
import { createInterface } from "node:readline";
import { closeDatabase, getUsersCollection } from "./db.js";
import { hashPassword, MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from "./auth.js";

// Create a team account, or set a new password for an existing one.
//   cd backend
//   npm run user -- jaya
// It asks for the password twice. The password is not shown while typing.

// Lines typed (or piped in) when the input is not a terminal.
const pipedLines: string[] = [];
let pipedReader: ReturnType<typeof createInterface> | null = null;

// Ask a question and read the answer without showing it on screen.
function askHidden(question: string): Promise<string> {
  process.stdout.write(question);

  // Not a terminal (for example input from a file): read one line.
  if (!process.stdin.isTTY) {
    if (!pipedReader) {
      pipedReader = createInterface({ input: process.stdin });
      // Some programs (like PowerShell) put an invisible "BOM" mark before piped text. Remove it.
      pipedReader.on("line", (line) => pipedLines.push(line.replace(/^﻿/, "")));
    }
    return new Promise((resolve) => {
      const check = () => (pipedLines.length > 0 ? resolve(pipedLines.shift()!) : setTimeout(check, 20));
      check();
    }).then((answer) => {
      process.stdout.write("\n");
      return answer as string;
    });
  }

  // A terminal: read key by key and do not print them.
  return new Promise((resolve) => {
    let answer = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (key: string) => {
      for (const char of key) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(answer);
          return;
        }
        if (char === "\u0003") {
          // Ctrl+C
          process.stdout.write("\nCancelled.\n");
          process.exit(1);
        }
        if (char === "\u0008" || char === "\u007f") answer = answer.slice(0, -1); // Backspace
        else answer += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const username = (process.argv[2] ?? "").trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    console.log("Usage: npm run user -- <username>");
    console.log("A username is 3 to 32 characters: lowercase letters, numbers, dot, dash or underscore.");
    process.exit(1);
  }

  const password = await askHidden(`New password for "${username}": `);
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.log(`The password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
    process.exit(1);
  }
  const again = await askHidden("Type it again: ");
  if (again !== password) {
    console.log("The two passwords are not the same. Nothing was changed.");
    process.exit(1);
  }

  const users = await getUsersCollection();
  const now = new Date();
  const result = await users.updateOne(
    { username },
    { $set: { passwordHash: await hashPassword(password), updatedAt: now }, $setOnInsert: { username, createdAt: now } },
    { upsert: true },
  );
  console.log(result.upsertedCount === 1 ? `Account "${username}" created.` : `New password set for "${username}".`);
  await closeDatabase();
  pipedReader?.close();
}

main().catch(async (error) => {
  console.log(`Could not save the account: ${error instanceof Error ? error.message.replace(/mongodb(\+srv)?:\/\/\S+/gi, "[hidden]") : error}`);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
