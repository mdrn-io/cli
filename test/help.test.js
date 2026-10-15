import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, CONSOLE_ONLY_NOTE, CliError, GROUPS, SPEC, parse, resolveCommand, unknown } from "../src/client.js";
import { advise, help, version } from "../src/help.js";

const main = new URL("../src/main.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// A directory with no .mdrn/link.json above it, and no profile.
function mdrn(args, { env = {}, cwd } = {}) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "mdrn-help-"));
  try {
    return spawnSync(process.execPath, [main, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, MDRN_CONFIG: join(dir, "absent.json"), ...env } });
  } finally { if (!cwd) rmSync(dir, { recursive: true, force: true }); }
}

test("--help lists every command once, by its first word, and says what the console keeps", () => {
  const text = help();
  for (const entry of SPEC) {
    const shown = text.split("\n").filter((line) => line.startsWith(`  mdrn ${entry.name}${entry.usage ? ` ${entry.usage}` : ""}`));
    assert.equal(shown.length, 1, entry.name);
    assert.ok(text.includes(entry.summary), entry.name);
  }
  for (const group of GROUPS) if (COMMANDS.filter((name) => name.split(" ")[0] === group).length > 1) assert.match(text, new RegExp(`^${group}\\n  mdrn ${group} `, "m"));
  assert.ok(text.includes(CONSOLE_ONLY_NOTE));
  assert.match(text, /tokens create, rotate, edit/);
  assert.match(text, /billing checkout, billing portal and tokens revoke need a scope a browser sign-in never holds/);
  assert.match(text, /Run mdrn <group> --help/);
  assert.match(text, /a search, not a stream/);
});

test("mdrn <group> --help shows that group only", () => {
  const text = help("builds");
  assert.deepEqual(text.split("\n").filter((line) => line.startsWith("  mdrn ")).map((line) => line.split("  ")[1]), ["mdrn builds list", "mdrn builds get <id>", "mdrn builds logs <id> [--follow]", "mdrn builds cancel <id>"]);
  assert.ok(!text.includes("mdrn deploy"));
  assert.match(help("login"), /mdrn login .*--token secret\|-/);
  assert.throws(() => help("frob"), (error) => error instanceof CliError && error.exitCode === 2 && error.message === "Unknown command frob. Run mdrn --help.");
});

test("-h is --help, and the flags never swallow a word", () => {
  assert.deepEqual(parse(["-h"]), { positionals: [], options: { help: true } });
  assert.deepEqual(parse(["builds", "-h"]), { positionals: ["builds"], options: { help: true } });
  assert.deepEqual(parse(["--help", "builds"]), { positionals: ["builds"], options: { help: true } });
  assert.deepEqual(parse(["--version", "x"]), { positionals: ["x"], options: { version: true } });
  assert.deepEqual(parse(["request", "POST", "/v1/x", "--data", "-"]).options, { data: "-" });
});

test("an unknown command is one line pointing at the help, not the whole list", () => {
  assert.equal(unknown([]), "A command is required. Run mdrn --help.");
  assert.equal(unknown(["frob", "x"]), "Unknown command frob. Run mdrn --help.");
  assert.equal(unknown(["builds", "frob", "x"]), "Unknown command builds frob. Run mdrn builds --help.");
  assert.throws(() => resolveCommand(parse(["builds", "frob"])), (error) => error.exitCode === 2 && error.message === "Unknown command builds frob. Run mdrn builds --help.");
  assert.throws(() => resolveCommand(parse(["frob"])), (error) => error.exitCode === 2 && error.message === "Unknown command frob. Run mdrn --help." && !error.message.includes("products"));
});

test("--version is the package's version", () => {
  assert.equal(version(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

test("the command line answers --help, -h, help, a bare mdrn and --version without a profile", () => {
  for (const args of [["--help"], ["-h"], ["help"], []]) {
    const result = mdrn(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^mdrn <command> \[options\]/);
    assert.match(result.stdout, /\n  mdrn deploy \[dir\]/);
  }
  const group = mdrn(["variables", "--help"]);
  assert.equal(group.status, 0);
  assert.match(group.stdout, /mdrn variables set NAME/);
  assert.ok(!group.stdout.includes("mdrn deploy"));
  assert.equal(mdrn(["help", "domains"]).stdout.split("\n").filter((line) => line.startsWith("  mdrn ")).length, 6);
  assert.equal(mdrn(["--version"]).stdout, `${version()}\n`);
  const bad = mdrn(["frob"]);
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr, "Unknown command frob. Run mdrn --help.\n");
});

test("an error says what to do next: a refused credential, a missing scope flag", async () => {
  assert.equal(advise(Object.assign(new CliError("UNAUTHENTICATED: expired"), { status: 401 }), "oauth"), "UNAUTHENTICATED: expired. Run mdrn login.");
  assert.equal(advise(Object.assign(new CliError("UNAUTHENTICATED: revoked"), { status: 401 }), "token"), "UNAUTHENTICATED: revoked. Run mdrn login.");
  assert.match(advise(Object.assign(new CliError("UNAUTHENTICATED: revoked"), { status: 401 }), "env"), /MDRN_API_TOKEN was refused: set a valid management token, or unset it and run mdrn login\.$/);
  assert.equal(advise(new CliError("--project is required", 2)), "--project is required. Run mdrn link in the app directory, or pass the flag.");
  assert.equal(advise(new CliError("--service is required", 2)), "--service is required. Run mdrn link in the app directory, or pass the flag.");
  assert.equal(advise(new CliError("--workspace is required", 2)), "--workspace is required. Run mdrn login, which stores the workspace, or pass the flag.");
  assert.equal(advise(Object.assign(new CliError("FORBIDDEN: no"), { status: 403 })), "FORBIDDEN: no");
  assert.equal(advise(new CliError("--name is required", 2)), "--name is required");
  const missing = mdrn(["builds", "list", "--service", "svc_1"], { env: { MDRN_API_TOKEN: "t" } });
  assert.equal(missing.status, 2);
  assert.equal(missing.stderr, "--project is required. Run mdrn link in the app directory, or pass the flag.\n");
  // The server answers in this process, so the CLI runs without blocking the event loop.
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => { response.writeHead(401, { "content-type": "application/json" }); response.end('{"error":{"code":"UNAUTHENTICATED","message":"The token was revoked"}}'); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "mdrn-help-"));
  try {
    const child = spawn(process.execPath, [main, "projects", "list", "--workspace", "w"], { cwd: dir, env: { ...process.env, MDRN_CONFIG: join(dir, "absent.json"), MDRN_API_TOKEN: "t", MDRN_API_ORIGIN: `http://127.0.0.1:${server.address().port}` } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 1);
    assert.equal(stderr, "UNAUTHENTICATED: The token was revoked. MDRN_API_TOKEN was refused: set a valid management token, or unset it and run mdrn login.\n");
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
