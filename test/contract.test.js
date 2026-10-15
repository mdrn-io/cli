import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMANDS, parse, resolveCommand } from "../src/client.js";

// The snapshot holds exactly the operations the commands call: every README example must land
// on one of them, and every route the multi-request commands walk must be there too.
const spec = JSON.parse(readFileSync(new URL("../contracts/client.openapi.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

// Splits a README example line the way a shell would, for the quoting the README uses.
const words = (line) => [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

// The snapshot's template for a concrete path: literal segments match, {x} segments take any id.
function templated(path) {
  const parts = path.split("?")[0].split("/");
  return Object.keys(spec.paths).find((candidate) => {
    const segments = candidate.split("/");
    return segments.length === parts.length && segments.every((segment, index) => /^\{.+\}$/.test(segment) || segment === parts[index]);
  });
}

function described(method, path) {
  const template = templated(path);
  assert.ok(template, `${method} ${path} is not in contracts/client.openapi.json`);
  assert.ok(spec.paths[template][method.toLowerCase()], `${method} ${template} is not in contracts/client.openapi.json`);
}

// What the commands that make several requests call (src/deploy.js, src/link.js, src/session.js,
// src/auth.js), by the command's kind.
const FLOWS = {
  deploy: [["POST", "/v1/deploy/uploads"], ["PUT", "/v1/deploy/uploads/upl_1/content"], ["POST", "/v1/deploy/uploads/upl_1/complete"], ["POST", "/v1/deploy/builds"], ["GET", "/v1/deploy/builds/bld_1/logs"], ["GET", "/v1/deploy/builds/bld_1"], ["GET", "/v1/deploy/deployments/dep_1"]],
  publish: [["POST", "/v1/deploy/deployments"], ["GET", "/v1/deploy/deployments/dep_1"]],
  github: [["GET", "/v1/deploy/github/installations"], ["GET", "/v1/deploy/github/repositories"], ["PUT", "/v1/deploy/services/svc_1/github"]],
  logs: [["GET", "/v1/deploy/builds/bld_1/logs"]],
  search: [["GET", "/v1/deploy/logs"]],
  link: [["GET", "/v1/platform/projects"], ["GET", "/v1/deploy/services"]],
  whoami: [["GET", "/v1/platform/me"]],
  login: [["GET", "/.well-known/oauth-authorization-server"], ["POST", "/oauth/token"], ["GET", "/v1/platform/me"]],
  logout: [["POST", "/oauth/revoke"]],
  init: [],
  open: [],
};

test("every README example calls an operation the contract snapshot describes", () => {
  const lines = readme.split(/\r?\n/).filter((line) => line.startsWith("mdrn ") && !line.includes("..."));
  assert.ok(lines.length > 50);
  const kinds = new Set();
  for (const line of lines) {
    const argv = words(line.replace(/#.*$/, "").replace(/\[[^\]]*\]/g, "").replace(/<.*$/, "")).slice(1);
    const command = resolveCommand(parse(argv));
    if (command.kind !== undefined && command.kind !== "search" && command.kind !== "whoami") {
      assert.ok(command.kind in FLOWS, `${line}: ${command.kind} has no known flow`);
      kinds.add(command.kind);
      continue;
    }
    described(command.method, command.path);
  }
  for (const [kind, flow] of Object.entries(FLOWS)) for (const [method, path] of flow) described(method, path);
  assert.deepEqual([...kinds].sort(), ["deploy", "github", "init", "link", "login", "logout", "logs", "open", "publish"]);
});

test("the snapshot is bounded to the commands: no console route, and nothing a command never calls", () => {
  // (The mail delivery callback is the app's webhook, set by mail callback set; the OAuth and
  // GitHub callbacks are the console's.)
  for (const path of Object.keys(spec.paths)) assert.doesNotMatch(path, /login|csrf|session|webhooks|console|(?<!mail\/)callback/);
  // Every listed route is reached by a command or a flow above (the README examples cover the
  // single-request ones), so a route added to the snapshot has a command behind it.
  const reached = new Set(Object.values(FLOWS).flat().map(([method, path]) => `${method.toLowerCase()} ${templated(path)}`));
  for (const line of readme.split(/\r?\n/).filter((l) => l.startsWith("mdrn ") && !l.includes("..."))) {
    const command = resolveCommand(parse(words(line.replace(/#.*$/, "").replace(/\[[^\]]*\]/g, "").replace(/<.*$/, "")).slice(1)));
    if (command.method && command.path) reached.add(`${command.method.toLowerCase()} ${templated(command.path)}`);
  }
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) if (item[method]) assert.ok(reached.has(`${method} ${path}`), `${method.toUpperCase()} ${path} is in the snapshot but no command calls it`);
  }
  assert.ok(COMMANDS.includes("request"));
});
