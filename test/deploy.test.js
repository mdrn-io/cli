import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CliError, parse, readDataFromStdin, resolveCommand } from "../src/client.js";
import { ignoreRules, ignored, MAX_SOURCE_BYTES, packSource, sourceFiles } from "../src/archive.js";
import { run } from "../src/deploy.js";
import { human, table } from "../src/format.js";

const scope = ["--project", "p", "--environment", "sandbox"];

// Reads back what tar() wrote: names (a PAX path wins over the header's) and contents.
function untar(gzipped) {
  const data = gunzipSync(gzipped);
  const entries = new Map();
  let longName;
  for (let offset = 0; offset + 512 <= data.length;) {
    const block = data.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const text = (start, length) => block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(text(124, 12), 8);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index];
    assert.equal(parseInt(text(148, 8), 8), sum, "header checksum");
    assert.equal(text(257, 6), "ustar");
    const body = data.subarray(offset + 512, offset + 512 + size);
    if (text(156, 1) === "x") longName = /\d+ path=(.*)\n/.exec(body.toString("utf8"))[1];
    else { entries.set(longName ?? text(0, 100), { data: body.toString("utf8"), mode: parseInt(text(100, 8), 8) }); longName = undefined; }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "mdrn-cli-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test(".mdrnignore reads as gitignore: comments, negation, directories only, anchors and **", () => {
  const rules = ignoreRules("# build output\ndist/\n*.log\n!keep.log\n/secret.txt\ndocs/**/*.pdf\ntmp?\n[ab].bin\n");
  assert.equal(ignored(rules, "dist", true), true);
  assert.equal(ignored(rules, "dist", false), false, "a trailing slash matches directories only");
  assert.equal(ignored(rules, "app/dist", true), true);
  assert.equal(ignored(rules, "a/b/debug.log", false), true);
  assert.equal(ignored(rules, "keep.log", false), false);
  assert.equal(ignored(rules, "secret.txt", false), true);
  assert.equal(ignored(rules, "app/secret.txt", false), false, "a leading slash anchors at the root");
  assert.equal(ignored(rules, "docs/a/b/c.pdf", false), true);
  assert.equal(ignored(rules, "docs/c.pdf", false), true);
  assert.equal(ignored(rules, "tmp1", false), true);
  assert.equal(ignored(rules, "tmp12", false), false);
  assert.equal(ignored(rules, "a.bin", false), true);
  assert.equal(ignored(rules, "c.bin", false), false);
});

test("packs the project under one root, without .git, node_modules or ignored files", () => {
  const long = "deep/" + "x".repeat(120) + "/index.js";
  const dir = project({
    "package.json": "{}", "src/index.js": "export default {}", [long]: "long",
    ".git/HEAD": "ref", "node_modules/a/index.js": "x", "app/node_modules/b.js": "x",
    "dist/out.js": "built", "notes.log": "log", ".mdrnignore": "dist/\n*.log\n",
  });
  try {
    assert.deepEqual(sourceFiles(dir), [".mdrnignore", long, "package.json", "src/index.js"]);
    const packed = packSource(dir);
    assert.equal(packed.sha256, createHash("sha256").update(packed.archive).digest("hex"));
    const entries = untar(packed.archive);
    assert.deepEqual([...entries.keys()], [".mdrnignore", long, "package.json", "src/index.js"].map((path) => `source/${path}`));
    assert.equal(entries.get(`source/${long}`).data, "long");
    assert.equal(entries.get("source/src/index.js").data, "export default {}");
    assert.equal(packSource(dir).sha256, packed.sha256, "the same files pack to the same bytes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("refuses an empty project, a missing directory and an archive over the limit before uploading", () => {
  assert.equal(MAX_SOURCE_BYTES, 95_000_000);
  const empty = project({ "node_modules/a.js": "x" });
  try {
    assert.throws(() => packSource(empty), (error) => error.exitCode === 2 && /no files to deploy/.test(error.message));
    assert.throws(() => packSource(join(empty, "missing")), /not a directory/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
  const big = project({ "blob.bin": randomBytes(4000) });
  try {
    assert.throws(() => packSource(big, 3000), (error) => error instanceof CliError && error.exitCode === 1 && /at most 0.003 MB/.test(error.message) && /\.mdrnignore/.test(error.message));
    assert.equal(packSource(big).files, 1);
  } finally { rmSync(big, { recursive: true, force: true }); }
});

// A fake Deploy API: answers by "METHOD /path", records every request.
function fakeApi(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    const { pathname, search } = new URL(url);
    const body = init.body === undefined ? undefined : Buffer.isBuffer(init.body) ? init.body : JSON.parse(init.body);
    calls.push({ method: init.method, path: pathname, search, headers: init.headers, body });
    const handler = routes[`${init.method} ${pathname}`];
    if (!handler) return Response.json({ error: { code: "NOT_FOUND", message: `${init.method} ${pathname}` } }, { status: 404 });
    const answer = handler({ search: new URLSearchParams(search), body, headers: init.headers, count: calls.filter((c) => c.path === pathname).length });
    return answer instanceof Response ? answer : Response.json(answer);
  };
  return { calls, fetcher };
}

function output() {
  const out = [];
  const err = [];
  return { out, err, context: { out: (line) => out.push(line), err: (line) => err.push(line), pollMs: 1 } };
}

const upload = { id: "upl_1", url: "https://elsewhere.example/v1/deploy/uploads/upl_1/content", method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer capability" }, expiresAt: 1, maxBytes: 1 };
function deployRoutes({ buildState = "succeeded", deploymentState = "ready", errorCode = null, pages } = {}) {
  const logPages = pages ?? [
    { items: [{ sequence: 1, message: "Installing" }, { sequence: 2, message: "Bundling" }], nextCursor: "2", state: "building", complete: false },
    { items: [], nextCursor: "2", state: "building", complete: false },
    { items: [{ sequence: 3, message: "Done" }], nextCursor: "3", state: buildState, complete: true },
    { items: [], nextCursor: "3", state: buildState, complete: true },
  ];
  let page = 0;
  return {
    "POST /v1/deploy/uploads": () => Response.json(upload, { status: 201 }),
    "PUT /v1/deploy/uploads/upl_1/content": () => ({ state: "uploaded", uploadId: "upl_1" }),
    "POST /v1/deploy/uploads/upl_1/complete": () => ({ sourceId: "src_1", state: "ready" }),
    "POST /v1/deploy/builds": () => Response.json({ buildId: "bld_1", state: "queued", logsUrl: "/v1/deploy/builds/bld_1/logs" }, { status: 202 }),
    "GET /v1/deploy/builds/bld_1/logs": () => logPages[Math.min(page++, logPages.length - 1)],
    "GET /v1/deploy/builds/bld_1": ({ count }) => ({ id: "bld_1", state: buildState, errorCode, deploymentId: buildState === "succeeded" && count > 1 ? "dep_1" : null }),
    "GET /v1/deploy/deployments/dep_1": ({ count }) => ({ id: "dep_1", state: count > 1 ? deploymentState : "publishing", errorCode: deploymentState === "ready" ? null : "PUBLISH_FAILED", hostname: "shop.apps.mdrn.io" }),
  };
}

test("deploy uploads the archive with the upload's own capability, builds, streams logs and waits for it to go live", async () => {
  const dir = project({ "index.html": "<h1>hi</h1>" });
  try {
    const api = fakeApi(deployRoutes());
    const { out, err, context } = output();
    const command = resolveCommand(parse(["deploy", dir, "--service", "svc_1", ...scope, "--idempotency-key", "release-7"]));
    assert.equal(await run(command, { ...context, token: "mgmt", fetcher: api.fetcher }), null);
    assert.deepEqual(out, ["Installing", "Bundling", "Done", "Live: https://shop.apps.mdrn.io (deployment dep_1)"]);
    assert.match(err[0], /Packed 1 files/);
    const [create, put, complete, build] = api.calls;
    assert.deepEqual(create.body, { serviceId: "svc_1", kind: "source_archive", bytes: put.body.length, sha256: createHash("sha256").update(put.body).digest("hex") });
    assert.equal(create.headers.get("authorization"), "Bearer mgmt");
    assert.equal(create.headers.get("mdrn-project"), "p");
    assert.equal(create.headers.get("idempotency-key"), "release-7-upload");
    // The bytes go to the configured API origin, never the URL in the answer, with the capability.
    assert.equal(put.path, "/v1/deploy/uploads/upl_1/content");
    assert.equal(put.headers.get("authorization"), "Bearer capability");
    assert.ok(Buffer.isBuffer(put.body));
    assert.equal(untar(put.body).get("source/index.html").data, "<h1>hi</h1>");
    assert.deepEqual(complete.body, { sha256: create.body.sha256 });
    assert.equal(complete.headers.get("idempotency-key"), "release-7-complete");
    assert.deepEqual(build.body, { serviceId: "svc_1", sourceId: "src_1" });
    assert.equal(build.headers.get("idempotency-key"), "release-7-build");
    assert.deepEqual(api.calls.filter((c) => c.path.endsWith("/logs")).map((c) => c.search), ["?cursor=0", "?cursor=2", "?cursor=2", "?cursor=3"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deploy --json keeps the build output on stderr and prints only the result", async () => {
  const dir = project({ "index.html": "x" });
  try {
    const api = fakeApi(deployRoutes());
    const { out, err, context } = output();
    const result = await run(resolveCommand(parse(["deploy", dir, "--service", "svc_1", ...scope, "--json"])), { ...context, json: true, token: "t", fetcher: api.fetcher });
    assert.deepEqual(result, { serviceId: "svc_1", sourceId: "src_1", buildId: "bld_1", deploymentId: "dep_1", state: "ready", hostname: "shop.apps.mdrn.io" });
    assert.deepEqual(out, []);
    assert.ok(err.includes("Done"));
    assert.match(api.calls[0].headers.get("idempotency-key"), /^cli-[0-9a-f-]{36}-upload$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deploy stops at a refused upload, before sending any byte", async () => {
  const dir = project({ "index.html": "x" });
  try {
    const api = fakeApi({ ...deployRoutes(), "POST /v1/deploy/uploads": () => Response.json({ error: { code: "UPLOAD_TOO_LARGE", message: "Uploads are limited to 50 MB." } }, { status: 413 }) });
    await assert.rejects(run(resolveCommand(parse(["deploy", dir, "--service", "svc_1", ...scope])), { ...output().context, token: "t", fetcher: api.fetcher }), (error) => error.exitCode === 1 && /UPLOAD_TOO_LARGE: Uploads are limited/.test(error.message));
    assert.equal(api.calls.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deploy stops when the bytes are refused, and never completes the upload", async () => {
  const dir = project({ "index.html": "x" });
  try {
    const api = fakeApi({ ...deployRoutes(), "PUT /v1/deploy/uploads/upl_1/content": () => Response.json({ error: { code: "INVALID_REQUEST", message: "The uploaded archive does not match its declared size and SHA-256" } }, { status: 400 }) });
    await assert.rejects(run(resolveCommand(parse(["deploy", dir, "--service", "svc_1", ...scope])), { ...output().context, token: "t", fetcher: api.fetcher }), /does not match/);
    assert.deepEqual(api.calls.map((c) => c.method), ["POST", "PUT"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed build shows its output and exits 1 with its error code", async () => {
  const dir = project({ "index.html": "x" });
  try {
    const api = fakeApi(deployRoutes({ buildState: "failed", errorCode: "BUILD_FAILED" }));
    const { out, context } = output();
    await assert.rejects(run(resolveCommand(parse(["deploy", dir, "--service", "svc_1", ...scope])), { ...context, token: "t", fetcher: api.fetcher }), (error) => error.exitCode === 1 && /Build bld_1 failed \(BUILD_FAILED\)/.test(error.message));
    assert.deepEqual(out, ["Installing", "Bundling", "Done"]);
    assert.ok(!api.calls.some((c) => c.path.startsWith("/v1/deploy/deployments")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a build whose deployment fails exits 1", async () => {
  const dir = project({ "index.html": "x" });
  try {
    const api = fakeApi(deployRoutes({ deploymentState: "failed" }));
    await assert.rejects(run(resolveCommand(parse(["deploy", dir, "--service", "svc_1", ...scope])), { ...output().context, token: "t", fetcher: api.fetcher }), /Deployment dep_1 failed \(PUBLISH_FAILED\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deploy gives up after --timeout and says the build carries on", async () => {
  const dir = project({ "index.html": "x" });
  try {
    const api = fakeApi(deployRoutes({ pages: [{ items: [], nextCursor: "0", state: "building", complete: false }] }));
    await assert.rejects(run(resolveCommand(parse(["deploy", dir, "--service", "svc_1", ...scope, "--timeout", "1"])), { ...output().context, pollMs: 20, token: "t", fetcher: api.fetcher }), (error) => error.exitCode === 1 && /Timed out after 1 seconds/.test(error.message) && /mdrn builds get bld_1/.test(error.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => resolveCommand(parse(["deploy", ".", "--service", "s", ...scope, "--timeout", "0"])), /whole number of seconds/);
  assert.throws(() => resolveCommand(parse(["deploy", ".", ...scope])), /--service is required/);
});

test("builds logs prints what there is, and --follow waits for the build to end", async () => {
  const routes = deployRoutes();
  const api = fakeApi(routes);
  const once = output();
  assert.equal(await run(resolveCommand(parse(["builds", "logs", "bld_1", ...scope])), { ...once.context, token: "t", fetcher: api.fetcher }), null);
  assert.deepEqual(once.out, ["Installing", "Bundling"]);
  const followed = output();
  await run(resolveCommand(parse(["builds", "logs", "bld_1", ...scope, "--follow"])), { ...followed.context, token: "t", fetcher: fakeApi(deployRoutes()).fetcher });
  assert.deepEqual(followed.out, ["Installing", "Bundling", "Done"]);
});

test("rollback publishes the earlier artifact and waits until it serves, or exits 1", async () => {
  const routes = { ...deployRoutes(), "POST /v1/deploy/deployments": () => Response.json({ deploymentId: "dep_1", operationId: "dep_1", state: "accepted" }, { status: 202 }) };
  const api = fakeApi(routes);
  const { out, context } = output();
  await run(resolveCommand(parse(["rollback", "--service", "svc_1", "--artifact", "art_1", ...scope, "--idempotency-key", "rb-1"])), { ...context, token: "t", fetcher: api.fetcher });
  assert.deepEqual(api.calls[0].body, { serviceId: "svc_1", artifactId: "art_1" });
  assert.equal(api.calls[0].headers.get("idempotency-key"), "rb-1");
  assert.deepEqual(out, ["Live: https://shop.apps.mdrn.io (deployment dep_1)"]);
  const failing = fakeApi({ ...deployRoutes({ deploymentState: "failed" }), "POST /v1/deploy/deployments": routes["POST /v1/deploy/deployments"] });
  await assert.rejects(run(resolveCommand(parse(["rollback", "--service", "svc_1", "--artifact", "art_1", ...scope])), { ...output().context, token: "t", fetcher: failing.fetcher }), /Deployment dep_1 failed/);
  const gone = fakeApi({ "POST /v1/deploy/deployments": () => Response.json({ error: { code: "CONFLICT", message: "That artifact was pruned." } }, { status: 409 }) });
  await assert.rejects(run(resolveCommand(parse(["rollback", "--service", "svc_1", "--artifact", "art_1", ...scope])), { ...output().context, token: "t", fetcher: gone.fetcher }), /CONFLICT/);
  assert.throws(() => resolveCommand(parse(["rollback", "--service", "svc_1", ...scope])), /--artifact is required/);
});

test("github connect finds the repository by name among the project's installations", async () => {
  const routes = {
    "GET /v1/deploy/github/installations": () => ({ items: [{ id: "11", accountLogin: "other" }, { id: "22", accountLogin: "acme" }], nextCursor: null }),
    "GET /v1/deploy/github/repositories": ({ search }) => ({ items: search.get("installationId") === "22" ? [{ repositoryId: 987, repository: "Acme/Shop", defaultBranch: "main" }] : [], nextCursor: null }),
    "PUT /v1/deploy/services/svc_1/github": ({ body }) => ({ serviceId: "svc_1", repository: "Acme/Shop", branch: body.branch ?? "main", autoDeploy: true }),
  };
  const api = fakeApi(routes);
  const result = await run(resolveCommand(parse(["github", "connect", "--service", "svc_1", "--repo", "acme/shop", "--branch", "release", ...scope])), { ...output().context, token: "t", fetcher: api.fetcher });
  assert.equal(result.branch, "release");
  assert.deepEqual(api.calls.at(-1).body, { installationId: "22", repositoryId: "987", branch: "release" });
  await assert.rejects(run(resolveCommand(parse(["github", "connect", "--service", "svc_1", "--repo", "acme/missing", ...scope])), { ...output().context, token: "t", fetcher: fakeApi(routes).fetcher }), (error) => error.exitCode === 1 && /not a repository GitHub lets MDRN see/.test(error.message));
  assert.throws(() => resolveCommand(parse(["github", "connect", "--service", "svc_1", "--repo", "https://github.com/acme/shop", ...scope])), /owner\/name/);
});

test("builds, releases, deployments, services, variables and whoami resolve to Deploy and Platform routes", () => {
  const r = (...argv) => resolveCommand(parse([...argv, ...scope]));
  assert.equal(r("builds", "list", "--service", "svc 1").path, "/v1/deploy/builds?serviceId=svc%201");
  assert.equal(r("builds", "get", "bld_1").path, "/v1/deploy/builds/bld_1");
  const cancel = r("builds", "cancel", "bld_1");
  assert.equal(cancel.path, "/v1/deploy/builds/bld_1/cancel");
  assert.match(cancel.idempotencyKey, /^cli-/);
  assert.equal(r("releases", "list", "--service", "svc_1").path, "/v1/deploy/releases?serviceId=svc_1");
  assert.equal(r("deployments", "list", "--service", "svc_1").path, "/v1/deploy/deployments?serviceId=svc_1");
  assert.deepEqual(r("services", "create", "--name", "shop", "--hostname-label", "shop-app").body, { name: "shop", hostnameLabel: "shop-app" });
  assert.equal(r("services", "disable", "svc_1").path, "/v1/deploy/services/svc_1/disable");
  assert.equal(r("services", "enable", "svc_1", "--idempotency-key", "on-1").idempotencyKey, "on-1");
  assert.equal(r("variables", "list", "--service", "svc_1").path, "/v1/deploy/services/svc_1/variables");
  const set = r("variables", "set", "API_KEY", "--service", "svc_1", "--value", "s3cret");
  assert.equal(set.method, "PUT");
  assert.deepEqual(set.body, { value: "s3cret", secret: true, build: false });
  assert.deepEqual(r("variables", "set", "MODE", "--plain", "--build", "--service", "svc_1", "--value", "fast").body, { value: "fast", secret: false, build: true });
  assert.equal(r("variables", "unset", "API_KEY", "--service", "svc_1").method, "DELETE");
  for (const name of ["lower", "MDRN_X", "A-B"]) assert.throws(() => r("variables", "set", name, "--service", "svc_1", "--value", "v"), /capitals/);
  assert.throws(() => r("builds", "get"), /A build ID is required/);
  assert.throws(() => r("builds", "cancel", "bld_1", "--idempotency-key", ""), /--idempotency-key is required/);
  assert.throws(() => resolveCommand(parse(["builds", "list", "--service", "s"])), /--project is required/);
  assert.deepEqual(resolveCommand(parse(["whoami"])), { kind: "whoami", method: "GET", path: "/v1/platform/me" });
  const cancel2 = r("deployments", "cancel", "dep_1");
  assert.equal(cancel2.path, "/v1/deploy/deployments/dep_1/cancel");
  assert.equal(cancel2.method, "POST");
  assert.match(cancel2.idempotencyKey, /^cli-/);
  assert.throws(() => r("deployments", "cancel"), /A deployment ID is required/);
  // The existing inspection commands keep their meaning beside `deploy [dir]`.
  assert.equal(r("deploy", "services").path, "/v1/deploy/services");
  assert.equal(r("deploy", "--service", "svc_1").dir, ".");
  assert.equal(r("deploy", "./services", "--service", "svc_1").dir, "./services");
});

test("logs searches the environment's application logs, and --follow repeats the search from the newest item seen", async () => {
  const then = Date.now();
  const once = resolveCommand(parse(["logs", "--q", "checkout failed", "--level", "warn,error", "--service", "svc_1", "--since", "15m", ...scope]));
  assert.equal(once.kind, "search");
  assert.deepEqual(once.query, { q: "checkout failed", level: "warn,error", service: "svc_1" });
  assert.ok(once.from >= then - 15 * 60_000 && once.from <= Date.now() - 15 * 60_000 + 1000);
  assert.equal(resolveCommand(parse(["logs", ...scope])).from, undefined);
  assert.throws(() => resolveCommand(parse(["logs", "--since", "15", ...scope])), /--since takes/);
  assert.throws(() => resolveCommand(parse(["logs", "--level", "fatal", ...scope])), /--level is a comma-separated list/);
  assert.throws(() => resolveCommand(parse(["logs", "tail", ...scope])), (error) => error.exitCode === 2 && error.message === "Unknown command logs tail. Run mdrn logs --help.");
  assert.equal(resolveCommand(parse(["logs", "trace", "tr_1", ...scope])).path, "/v1/deploy/logs/trace/tr_1");
  assert.throws(() => resolveCommand(parse(["logs", "trace", ...scope])), /A trace ID is required/);
  const items = [{ timestamp: 1_760_000_000_500, kind: "log", level: "warn", serviceName: "web", message: "checkout failed" }, { timestamp: 1_760_000_000_000, kind: "invocation", serviceName: "web", method: "POST", path: "/checkout", status: 500 }];
  const api = fakeApi({ "GET /v1/deploy/logs": () => ({ items, nextCursor: null, sampled: false, partial: false, source: "recent", retainedFrom: 1 }) });
  const page = await run(once, { ...output().context, token: "t", fetcher: api.fetcher });
  assert.equal(page.items.length, 2);
  assert.equal(api.calls[0].search, `?q=checkout+failed&level=warn%2Cerror&service=svc_1&from=${once.from}`);
  assert.equal(api.calls[0].headers.get("mdrn-project"), "p");
  // Following: the first round shows one page, oldest first; each later round asks from a
  // millisecond after the newest item, walking its pages; nothing is shown twice.
  const controller = new AbortController();
  let round = 0;
  const following = fakeApi({ "GET /v1/deploy/logs": ({ search }) => {
    round += 1;
    if (round === 1) return { items, nextCursor: "older", sampled: false, partial: false, source: "recent", retainedFrom: 1 };
    assert.equal(search.get("from"), round === 2 || round === 3 ? "1760000000501" : "1760000001001");
    if (round === 2) return { items: [{ timestamp: 1_760_000_001_000, kind: "log", level: "info", serviceName: "web", message: "second" }], nextCursor: "more" };
    if (round === 3) { assert.equal(search.get("cursor"), "more"); return { items: [{ timestamp: 1_760_000_000_800, kind: "exception", level: "error", serviceName: "web", message: "boom" }], nextCursor: null }; }
    controller.abort();
    return { items: [], nextCursor: null };
  } });
  const { out, context } = output();
  assert.equal(await run(resolveCommand(parse(["logs", "--follow", ...scope])), { ...context, token: "t", fetcher: following.fetcher, signal: controller.signal }), null);
  assert.deepEqual(out, [
    "2025-10-09T08:53:20.000Z  invocation  web  POST /checkout 500",
    "2025-10-09T08:53:20.500Z  log/warn  web  checkout failed",
    "2025-10-09T08:53:20.800Z  exception/error  web  boom",
    "2025-10-09T08:53:21.000Z  log/info  web  second",
  ]);
  assert.equal(following.calls[0].search, "");
  assert.equal(round, 4);
  // --json prints each new item as one line of JSON.
  const asJson = output();
  const once2 = new AbortController();
  await run(resolveCommand(parse(["logs", "--follow", "--since", "1h", ...scope])), { ...asJson.context, json: true, token: "t", signal: once2.signal, fetcher: fakeApi({ "GET /v1/deploy/logs": () => { once2.abort(); return { items: [items[1]], nextCursor: null }; } }).fetcher });
  assert.deepEqual(asJson.out.map((line) => JSON.parse(line)), [items[1]]);
});

test("--value - reads a variable's value from standard input, without its last newline", async () => {
  const parsed = await readDataFromStdin(parse(["variables", "set", "TOKEN", "--service", "s", "--value", "-", ...scope]), async () => "from-stdin\n");
  assert.equal(resolveCommand(parsed).body.value, "from-stdin");
});

test("flags never swallow the next word", () => {
  assert.deepEqual(parse(["--json", "builds", "list"]), { positionals: ["builds", "list"], options: { json: true } });
});

test("a refused single command exits 1 with the API's code", async () => {
  const api = fakeApi({ "POST /v1/deploy/builds/bld_1/cancel": () => Response.json({ error: { code: "INVALID_REQUEST", message: "The build already reached a terminal state" } }, { status: 400 }) });
  await assert.rejects(run(resolveCommand(parse(["builds", "cancel", "bld_1", ...scope])), { ...output().context, token: "t", fetcher: api.fetcher }), (error) => error.exitCode === 1 && /INVALID_REQUEST: The build already/.test(error.message));
});

test("people read tables and fields; times read as dates", () => {
  const listed = human({ items: [{ id: "bld_1", state: "succeeded", errorCode: null, createdAt: 1760000000, config: { a: 1 } }], nextCursor: "bld_1" }, ["id", "state", "errorCode", "createdAt"]);
  assert.equal(listed, "id     state      errorCode  createdAt\nbld_1  succeeded  -          2025-10-09T08:53:20Z\n\nnextCursor  bld_1");
  assert.equal(human({ items: [], nextCursor: null }), "(none)");
  assert.equal(human({ id: "svc_1", disabledAt: null }), "id          svc_1\ndisabledAt  -");
  // Logs give milliseconds, and a list of scopes reads as one cell.
  assert.equal(human({ items: [{ timestamp: 1760000000500, kind: "log", scopes: ["a:b", "c:d"] }], retainedFrom: 1760000000000 }, ["timestamp", "kind", "scopes"]), "timestamp                 kind  scopes\n2025-10-09T08:53:20.500Z  log   a:b,c:d\n\nretainedFrom  2025-10-09T08:53:20.000Z");
  assert.match(human({ account: { id: "a" }, grants: [{ workspaceId: "w", role: "admin", scopes: ["x"] }] }), /^account  \{"id":"a"\}\n\ngrants:\nworkspaceId  role\nw            admin$/);
  assert.equal(table([{ a: 1, b: { c: 2 } }]), "a\n1");
});

test("main.js deploys a directory over HTTP and prints the result with --json", async () => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const routes = deployRoutes();
  let uploaded;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://x");
      if (request.method === "PUT") uploaded = { body, authorization: request.headers.authorization };
      const handler = routes[`${request.method} ${url.pathname}`];
      const answer = handler({ search: url.searchParams, body, count: 2 });
      const res = answer instanceof Response ? answer : Response.json(answer);
      response.writeHead(res.status, { "content-type": "application/json" });
      response.end(await res.text());
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = project({ "index.html": "hello" });
  try {
    const main = new URL("../src/main.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const child = spawn(process.execPath, [main, "deploy", dir, "--service", "svc_1", ...scope, "--json"], {
      env: { ...process.env, MDRN_API_TOKEN: "t", MDRN_API_ORIGIN: `http://127.0.0.1:${server.address().port}`, MDRN_CONFIG: join(dir, "absent.json") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).deploymentId, "dep_1");
    assert.match(stderr, /Installing/);
    assert.equal(uploaded.authorization, "Bearer capability");
    assert.equal(untar(uploaded.body).get("source/index.html").data, "hello");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
