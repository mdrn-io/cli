import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, resolveCommand } from "../src/client.js";
import { configPath, credential, findLink, readConfig, settings, writeConfig } from "../src/config.js";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "mdrn-config-"));
  return { dir, path: join(dir, "mdrn", "config.json"), env: { MDRN_CONFIG: join(dir, "mdrn", "config.json") }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the file is found at MDRN_CONFIG, then $XDG_CONFIG_HOME/mdrn, then ~/.config/mdrn", () => {
  assert.equal(configPath({ MDRN_CONFIG: "/x/c.json", XDG_CONFIG_HOME: "/y" }), "/x/c.json");
  assert.equal(configPath({ XDG_CONFIG_HOME: "/y" }), join("/y", "mdrn", "config.json"));
  assert.match(configPath({}), /[\\/]\.config[\\/]mdrn[\\/]config\.json$/);
});

test("a file from before the schema was versioned reads as version 1 and is saved as such", () => {
  const { path, env, done } = home();
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ profiles: { default: { token: "file-token", project: "p1", environment: "sandbox" }, prod: { token: "prod-token", origin: "https://development.api.mdrn.io", environment: "production" } } }));
    const config = readConfig(path);
    assert.deepEqual(config, { version: 1, profiles: { default: { token: "file-token", project: "p1", environment: "sandbox" }, prod: { token: "prod-token", origin: "https://development.api.mdrn.io", environment: "production" } }, clients: {}, exists: true });
    const chosen = settings(env, {});
    assert.deepEqual({ token: chosen.token, origin: chosen.origin, authType: chosen.authType, options: chosen.options }, { token: "file-token", origin: undefined, authType: "token", options: { project: "p1", environment: "sandbox" } });
    assert.equal(settings({ ...env, MDRN_API_TOKEN: "env-token" }, {}).token, "env-token");
    const prod = settings({ ...env, MDRN_PROFILE: "prod" }, { environment: "sandbox" });
    assert.deepEqual({ token: prod.token, origin: prod.origin, options: prod.options }, { token: "prod-token", origin: "https://development.api.mdrn.io", options: { environment: "sandbox" } });
    assert.throws(() => settings(env, { profile: "missing" }), (error) => error.exitCode === 2 && /no profile missing/.test(error.message));
    writeConfig(path, config);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.version, 1);
    assert.deepEqual(Object.keys(saved), ["version", "profiles", "clients"]);
    assert.equal(saved.exists, undefined);
    writeFileSync(path, JSON.stringify({ version: 2, profiles: {} }));
    assert.throws(() => readConfig(path), /schema version 2/);
    writeFileSync(path, "{oops");
    assert.throws(() => settings(env, {}), (error) => error.exitCode === 2 && /not a readable JSON/.test(error.message));
  } finally { done(); }
});

test("without a file there is an empty configuration; a named profile then needs the file unless login is creating it", () => {
  const { env, done } = home();
  try {
    const absent = settings({ ...env, MDRN_API_TOKEN: "t" }, {});
    assert.deepEqual({ token: absent.token, origin: absent.origin, options: absent.options, name: absent.name }, { token: "t", origin: undefined, options: {}, name: "default" });
    assert.equal(absent.config.exists, false);
    assert.throws(() => settings(env, { profile: "x" }), /needs/);
    assert.equal(settings(env, { profile: "x" }, { lenient: true }).name, "x");
  } finally { done(); }
});

test("flags win over MDRN_* variables, which win over the directory's link, which wins over the profile", () => {
  const { dir, path, env, done } = home();
  try {
    writeConfig(path, { version: 1, profiles: { default: { token: "t", workspace: "ws_profile", project: "p_profile", environment: "production", service: "svc_profile" } }, clients: {} });
    const app = join(dir, "app");
    mkdirSync(join(app, ".mdrn"), { recursive: true });
    writeFileSync(join(app, ".mdrn", "link.json"), JSON.stringify({ workspace: "ws_link", project: "p_link", environment: "sandbox", service: "svc_link", extra: "ignored" }));
    assert.deepEqual(settings(env, {}, { cwd: app }).options, { workspace: "ws_link", project: "p_link", environment: "sandbox", service: "svc_link" });
    assert.deepEqual(settings(env, {}, { cwd: dir }).options, { workspace: "ws_profile", project: "p_profile", environment: "production", service: "svc_profile" });
    const withEnv = settings({ ...env, MDRN_WORKSPACE: "ws_env", MDRN_PROJECT: "p_env", MDRN_ENVIRONMENT: "production", MDRN_SERVICE: "svc_env" }, {}, { cwd: app });
    assert.deepEqual(withEnv.options, { workspace: "ws_env", project: "p_env", environment: "production", service: "svc_env" });
    const withFlags = settings({ ...env, MDRN_PROJECT: "p_env" }, { project: "p_flag", service: "svc_flag" }, { cwd: app });
    assert.deepEqual(withFlags.options, { project: "p_flag", service: "svc_flag", workspace: "ws_link", environment: "sandbox" });
    // Inside a linked directory, deploy needs no flags.
    const command = resolveCommand(parse(["deploy", ...Object.entries(settings(env, {}, { cwd: app }).options).flatMap(([k, v]) => [`--${k}`, v])]));
    assert.deepEqual({ kind: command.kind, serviceId: command.serviceId, project: command.project, environment: command.environment }, { kind: "deploy", serviceId: "svc_link", project: "p_link", environment: "sandbox" });
  } finally { done(); }
});

test("the link is found by walking up from the current directory, and only its selectors are read", () => {
  const { dir, done } = home();
  try {
    const root = join(dir, "repo");
    const deep = join(root, "packages", "web", "src");
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(root, ".mdrn"));
    writeFileSync(join(root, ".mdrn", "link.json"), JSON.stringify({ workspace: "ws", project: "p", environment: "sandbox", service: "svc", token: "never" }));
    const found = findLink(deep);
    assert.equal(found.dir, root);
    assert.deepEqual(found.link, { workspace: "ws", project: "p", environment: "sandbox", service: "svc" });
    assert.equal(findLink(dir), undefined);
    const nearer = join(root, "packages", "web", ".mdrn");
    mkdirSync(nearer);
    writeFileSync(join(nearer, "link.json"), JSON.stringify({ project: "p_nearer" }));
    assert.deepEqual(findLink(deep).link, { project: "p_nearer" }, "the nearest link wins, whole");
    writeFileSync(join(nearer, "link.json"), "{oops");
    assert.throws(() => findLink(deep), /not a readable JSON link/);
    assert.equal(settings({ MDRN_CONFIG: join(dir, "none.json") }, {}, { cwd: dir }).linkDir, undefined);
  } finally { done(); }
});

test("the file is written whole, readable only by its owner, in a directory only its owner enters", { skip: process.platform === "win32" ? "POSIX modes" : false }, () => {
  const { path, done } = home();
  try {
    writeConfig(path, { version: 1, profiles: { default: { token: "t" } }, clients: {} });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
    assert.ok(!existsSync(`${path}.tmp`));
  } finally { done(); }
});

test("credential answers the token as it is, a fresh sign-in's access token without a request, and says what to do without either", async () => {
  const { path, env, done } = home();
  try {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    writeConfig(path, { version: 1, profiles: {
      default: { token: "mgmt", auth: { type: "oauth", clientId: "c", accessToken: "access", refreshToken: "r", expiresAt: soon, scopes: [], account: "a" } },
      plain: { token: "mgmt" }, empty: { project: "p" },
    }, clients: {} });
    const noFetch = { fetcher: () => { throw new Error("must not fetch"); } };
    const signedIn = settings(env, {});
    assert.equal(signedIn.authType, "oauth", "auth wins over token");
    assert.equal(await credential(signedIn, noFetch), "access");
    assert.equal(await credential(settings(env, { profile: "plain" }), noFetch), "mgmt");
    assert.equal(settings(env, { profile: "plain" }).authType, "token");
    const fromEnv = settings({ ...env, MDRN_API_TOKEN: "env" }, {});
    assert.equal(fromEnv.authType, "env");
    assert.equal(await credential(fromEnv, noFetch), "env");
    await assert.rejects(credential(settings(env, { profile: "empty" }), noFetch), (error) => error.exitCode === 2 && /Sign in with mdrn login, or set MDRN_API_TOKEN/.test(error.message));
    // About to expire (inside the two-minute margin) means a refresh; a stale lock from a dead
    // process does not stand in the way, a live one does.
    const config = readConfig(path);
    config.profiles.default.auth.expiresAt = Math.floor(Date.now() / 1000) + 60;
    writeConfig(path, config);
    const refreshed = async (url, init) => url.endsWith("/.well-known/oauth-authorization-server")
      ? Response.json({ issuer: "http://127.0.0.1:1", authorization_endpoint: "http://127.0.0.1:1/oauth/authorize", token_endpoint: "http://127.0.0.1:1/oauth/token", registration_endpoint: "http://127.0.0.1:1/oauth/register", revocation_endpoint: "http://127.0.0.1:1/oauth/revoke" })
      : (assert.equal(new URLSearchParams(init.body).get("grant_type"), "refresh_token"), Response.json({ access_token: "access2", refresh_token: "r2", expires_in: 3600, token_type: "Bearer", scope: "project:read" }));
    writeFileSync(`${path}.lock`, "dead");
    const configured = settings({ ...env, MDRN_API_ORIGIN: "http://127.0.0.1:1" }, {});
    assert.equal(await credential(configured, { fetcher: refreshed, lock: { now: () => Date.now() + 120_000 } }), "access2");
    assert.deepEqual(readConfig(path).profiles.default.auth.refreshToken, "r2");
    assert.ok(!existsSync(`${path}.lock`));
    assert.equal(configured.auth.accessToken, "access2", "the rest of the command uses the new pair");
    const rotated = readConfig(path);
    rotated.profiles.default.auth.expiresAt = Math.floor(Date.now() / 1000) + 60;
    writeConfig(path, rotated);
    writeFileSync(`${path}.lock`, "alive");
    await assert.rejects(credential(settings({ ...env, MDRN_API_ORIGIN: "http://127.0.0.1:1" }, {}), { fetcher: refreshed, lock: { pollMs: 5, waitMs: 30 } }), /Another mdrn is refreshing/);
  } finally { done(); }
});
