#!/usr/bin/env node
import { CliError, parse, readDataFromStdin, resolveCommand } from "./client.js";
import { credential, settings } from "./config.js";
import { run } from "./deploy.js";
import { advise, help, version } from "./help.js";
import { SESSION_KINDS, session } from "./session.js";
import { human } from "./format.js";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

let authType;
try {
  const parsed = parse(process.argv.slice(2));
  const [first, second] = parsed.positionals;
  // Help and the version need no profile; a bare `mdrn` is help.
  if (parsed.options.version === true) process.stdout.write(version() + "\n");
  else if (parsed.options.help === true || first === "help" || first === undefined) process.stdout.write(help(first === "help" ? second : first) + "\n");
  else {
    // login may name a profile that does not exist yet.
    const configured = settings(process.env, parsed.options, { lenient: first === "login" });
    const { origin, options } = configured;
    authType = configured.authType;
    const command = resolveCommand(await readDataFromStdin({ ...parsed, options }, readStdin));
    const json = options.json === true;
    const context = {
      configured, origin, json, authType,
      credential: (force) => credential(configured, { force }),
      out: (line) => process.stdout.write(line + "\n"),
      err: (line) => process.stderr.write(line + "\n"),
    };
    const result = SESSION_KINDS.has(command.kind) ? await session(command, context) : await run(command, context);
    if (result !== null && result !== undefined) process.stdout.write((json ? JSON.stringify(result, null, 2) : human(result, command.columns)) + "\n");
  }
} catch (error) {
  const value = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error));
  process.stderr.write(advise(value, authType) + "\n");
  process.exitCode = value.exitCode;
}
