import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, resolveCommand } from "../src/client.js";
import { settings, writeConfig } from "../src/config.js";
import { sourceFiles } from "../src/archive.js";
import { session, TEMPLATE } from "../src/session.js";

// A fake API answering by "METHOD /path", recording every request (deploy.test.js has the same).
function fakeApi(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    const { pathname, search } = new URL(url);
    calls.push({ method: init.method, path: pathname, search, headers: init.headers });
    const handler = routes[`${init.method} ${pathname}`];
    if (!handler) return Response.json({ error: { code: "NOT_FOUND", message: `${init.method} ${pathname}` } }, { status: 404 });
    const answer = handler({ headers: init.headers });
    return answer instanceof Response ? answer : Response.json(answer);
  };
  return { calls, fetcher };
}

function output() {
  const out = [];
  const err = [];
  return { out, err, context: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), "mdrn-session-"));
  const path = join(dir, "config.json");
  writeConfig(path, { version: 1, profiles: { default: { token: "t", origin: "https://api.example", console: "https://console.example", workspace: "ws_1" } }, clients: {} });
  return { dir, path, env: { MDRN_CONFIG: path }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const runLink = (argv, env, cwd, fetcher) => {
  const configured = settings(env, parse(["link", ...argv]).options, { cwd });
  const { out, err, context } = output();
  return { out, err, result: session(resolveCommand({ positionals: ["link"], options: configured.options }), { ...context, configured, token: configured.token, origin: configured.origin, authType: configured.authType, fetcher, cwd }) };
};

test("link picks the only project and service, writes .mdrn/link.json, and deploy then needs no flags", async () => {
  const { dir, env, done } = home();
  try {
    const api = fakeApi({
      "GET /v1/platform/projects": () => ({ items: [{ id: "proj_1", name: "Shop", workspaceId: "ws_1" }], nextCursor: null }),
      "GET /v1/deploy/services": ({ headers }) => (assert.equal(headers.get("mdrn-project"), "proj_1"), assert.equal(headers.get("mdrn-environment"), "sandbox"), { items: [{ id: "svc_1", name: "web" }], nextCursor: null }),
    });
    const app = join(dir, "app");
    mkdirSync(app);
    const { err, result } = runLink([], env, app, api.fetcher);
    assert.equal(await result, null);
    assert.deepEqual(JSON.parse(readFileSync(join(app, ".mdrn", "link.json"), "utf8")), { workspace: "ws_1", project: "proj_1", environment: "sandbox", service: "svc_1" });
    assert.match(err[0], /^Linked .* to project proj_1 \(sandbox\), service svc_1\. Next: mdrn deploy$/);
    assert.equal(api.calls[0].search, "?workspaceId=ws_1");
    const linked = settings(env, {}, { cwd: join(app) });
    const command = resolveCommand({ positionals: ["deploy"], options: linked.options });
    assert.deepEqual({ serviceId: command.serviceId, project: command.project, environment: command.environment, dir: command.dir }, { serviceId: "svc_1", project: "proj_1", environment: "sandbox", dir: "." });
    writeFileSync(join(app, "index.html"), "x");
    assert.deepEqual(sourceFiles(app), ["index.html"], ".mdrn never travels in the archive");
    // Named flags are taken as they are, and production is a choice.
    await runLink(["--project", "proj_9", "--environment", "production", "--service", "svc_9"], env, app, () => { throw new Error("nothing to look up"); }).result;
    assert.deepEqual(JSON.parse(readFileSync(join(app, ".mdrn", "link.json"), "utf8")), { workspace: "ws_1", project: "proj_9", environment: "production", service: "svc_9" });
  } finally { done(); }
});

test("link lists the projects or services when there are several, and says what to do when there are none", async () => {
  const { dir, env, done } = home();
  try {
    const many = fakeApi({ "GET /v1/platform/projects": () => ({ items: [{ id: "proj_1", name: "Shop" }, { id: "proj_2", name: "Blog" }], nextCursor: null }) });
    const first = runLink([], env, dir, many.fetcher);
    await assert.rejects(first.result, (error) => error.exitCode === 2 && /Pass --project/.test(error.message));
    assert.equal(first.err[0], "projects in this workspace:\n  proj_1  Shop\n  proj_2  Blog");
    const none = fakeApi({ "GET /v1/platform/projects": () => ({ items: [{ id: "proj_1", name: "Shop" }], nextCursor: null }), "GET /v1/deploy/services": () => ({ items: [], nextCursor: null }) });
    await assert.rejects(runLink([], env, dir, none.fetcher).result, /no service in sandbox; create one with mdrn services create --name app --project proj_1 --environment sandbox/);
    await assert.rejects(runLink([], { MDRN_CONFIG: join(dir, "absent.json"), MDRN_API_TOKEN: "t" }, dir, none.fetcher).result, /--workspace is required/);
    assert.ok(!existsSync(join(dir, ".mdrn")));
    assert.throws(() => resolveCommand(parse(["link", "--environment", "development"])), /sandbox or production/);
  } finally { done(); }
});

test("init clones the template without its history, and says so when git is missing", async () => {
  const { dir, env, done } = home();
  try {
    const calls = [];
    const execFile = async (file, args) => {
      calls.push([file, ...args]);
      const target = args.at(-1);
      mkdirSync(join(target, ".git"), { recursive: true });
      writeFileSync(join(target, "package.json"), "{}");
    };
    const { err, context } = output();
    const configured = settings(env, {});
    assert.equal(await session(resolveCommand(parse(["init", "my-app"])), { ...context, configured, cwd: dir, execFile }), null);
    assert.deepEqual(calls, [["git", "clone", "--depth", "1", "--quiet", TEMPLATE, join(dir, "my-app")]]);
    assert.ok(existsSync(join(dir, "my-app", "package.json")));
    assert.ok(!existsSync(join(dir, "my-app", ".git")), "the template's history is dropped");
    assert.equal(err[0], `Created my-app from ${TEMPLATE}. Next: cd my-app && mdrn link && mdrn deploy`);
    await assert.rejects(session(resolveCommand(parse(["init", "my-app"])), { ...context, configured, cwd: dir, execFile }), /exists and is not empty/);
    const missing = async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); };
    await assert.rejects(session(resolveCommand(parse(["init", "other"])), { ...context, configured, cwd: dir, execFile: missing }), (error) => error.exitCode === 2 && /git is not on PATH/.test(error.message));
    const failing = async () => { throw Object.assign(new Error("exit 128"), { code: 128, stderr: "fatal: could not read from remote repository\n" }); };
    await assert.rejects(session(resolveCommand(parse(["init", "other"])), { ...context, configured, cwd: dir, execFile: failing }), /git clone failed: fatal: could not read/);
    assert.throws(() => resolveCommand(parse(["init"])), /A directory to create is required/);
  } finally { done(); }
});

test("open prints the console page for the profile's project and opens it", async () => {
  const { env, done } = home();
  try {
    const opened = [];
    const open = async (url) => { opened.push(url); return true; };
    const run = async (argv) => {
      const configured = settings(env, parse(argv).options);
      const { out, context } = output();
      await session(resolveCommand({ positionals: parse(argv).positionals, options: configured.options }), { ...context, configured, open });
      return out[0];
    };
    assert.equal(await run(["open"]), "https://console.example/");
    assert.equal(await run(["open", "billing", "--project", "proj_1"]), "https://console.example/billing?project=proj_1");
    assert.equal(await run(["open", "tokens", "--project", "proj_1", "--environment", "production"]), "https://console.example/settings?tab=tokens&project=proj_1&env=production");
    assert.equal(await run(["open", "project", "--project", "proj_1"]), "https://console.example/?project=proj_1");
    assert.equal(opened.length, 4);
    assert.throws(() => resolveCommand(parse(["open", "mail"])), /open takes project, billing, tokens or nothing/);
    assert.equal(await (async () => { const configured = settings({ MDRN_CONFIG: join(tmpdir(), "absent-config.json") }, {}); const { out, context } = output(); await session(resolveCommand(parse(["open", "billing"])), { ...context, configured, open }); return out[0]; })(), "https://console.mdrn.io/billing");
  } finally { done(); }
});

test("whoami adds the profile, origin, credential, workspace and expiry to the API's answer", async () => {
  const { path, env, done } = home();
  try {
    const api = fakeApi({ "GET /v1/platform/me": () => ({ account: { id: "acc_1", displayName: "Ann" }, user: { email: "ann@example.com" }, grants: [] }) });
    const run = async (vars = {}) => {
      const configured = settings({ ...env, ...vars }, {});
      return session(resolveCommand(parse(["whoami"])), { ...output().context, configured, token: configured.token, credential: async () => "access", origin: configured.origin, authType: configured.authType, fetcher: api.fetcher });
    };
    const byToken = await run();
    assert.deepEqual({ profile: byToken.profile, origin: byToken.origin, credential: byToken.credential, workspace: byToken.workspace, expiresAt: byToken.expiresAt, email: byToken.user.email }, { profile: "default", origin: "https://api.example", credential: "management token (profile default)", workspace: "ws_1", expiresAt: null, email: "ann@example.com" });
    assert.equal((await run({ MDRN_API_TOKEN: "env" })).credential, "management token (MDRN_API_TOKEN)");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.profiles.default.auth = { type: "oauth", clientId: "c", accessToken: "access", refreshToken: "r", expiresAt: 1760000000, scopes: [], account: "acc_1" };
    writeFileSync(path, JSON.stringify(config));
    const signedIn = await run();
    assert.equal(signedIn.credential, "browser sign-in (profile default)");
    assert.equal(signedIn.expiresAt, 1760000000);
    assert.equal(api.calls.at(-1).headers.get("authorization"), "Bearer access");
  } finally { done(); }
});
