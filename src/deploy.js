import { CliError, execute, readResponse, safeApiPath, secureOrigin } from "./client.js";
import { packSource } from "./archive.js";

// Each API call has its own bound; sending the archive may take minutes.
const CALL_MS = 30_000;
const UPLOAD_MS = 5 * 60_000;
// A build ends as built, failed or cancelled; a deployment as ready (serving) or not.
const BUILD_DONE = new Set(["succeeded", "failed", "cancelled"]);
const DEPLOYMENT_DONE = new Set(["ready", "failed", "cancelled", "superseded"]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deadline(command, context, what) {
  const end = Date.now() + command.timeout * 1000;
  return () => {
    if (Date.now() > end) throw new CliError(`Timed out after ${command.timeout} seconds waiting for ${what}. It carries on without the CLI: ${context.hint}`);
  };
}

// Runs one resolved command: a single request, or one of the commands that take several.
export async function run(command, context) {
  const call = (request, timeoutMs = CALL_MS) => execute({ project: command.project, environment: command.environment, ...request }, { ...context, timeoutMs });
  if (command.kind === "deploy") return deploy(command, context, call);
  if (command.kind === "publish") return publish(command, context, call);
  if (command.kind === "github") return connect(command, call);
  if (command.kind === "search") return search(command, context, call);
  if (command.kind === "logs") {
    const end = command.follow ? deadline({ timeout: 3600 }, { hint: `mdrn builds get ${command.buildId}` }, "the build") : () => {};
    await streamLogs(command.buildId, context, call, command.follow, end);
    return null;
  }
  return execute(command, context);
}

// Prints a build's output from the start, page by page; following, until the build has ended
// and every line it wrote is shown. Answers the build's last state.
export async function streamLogs(buildId, context, call, follow, checkDeadline) {
  const show = context.json ? context.err : context.out;
  let cursor = "0";
  for (;;) {
    const page = await call({ method: "GET", path: `/v1/deploy/builds/${encodeURIComponent(buildId)}/logs?cursor=${encodeURIComponent(cursor)}` });
    for (const item of page.items ?? []) show(String(item.message ?? ""));
    if (page.nextCursor !== undefined && page.nextCursor !== null) cursor = String(page.nextCursor);
    if (page.items?.length) continue;
    if (page.complete || !follow) return page.state;
    checkDeadline();
    await wait(context.pollMs ?? 2000);
  }
}

// One line of an application log item, as a person reads it following the logs.
export function logLine(item) {
  const at = Number.isFinite(item.timestamp) ? new Date(item.timestamp).toISOString() : "-";
  const what = item.kind === "invocation" ? [item.method, item.path, item.status].filter((part) => part !== null && part !== undefined).join(" ") : String(item.message ?? "");
  return [at, item.level ? `${item.kind}/${item.level}` : item.kind, item.serviceName ?? item.service ?? "-", what].join("  ");
}

// A search of the application logs: one page, newest first. With --follow the search is run
// again every 3 seconds from a millisecond after the newest item seen, and what is new is
// printed oldest first, as a tail reads; the first round shows one page, the later ones walk
// every page of their window. It is a search repeated, not a stream: a line can take seconds to
// appear, and context.signal (never set by the command line, where Ctrl-C ends it) stops it.
async function search(command, context, call) {
  const page = (from, cursor) => {
    const query = new URLSearchParams(command.query);
    if (from !== undefined) query.set("from", String(from));
    if (cursor !== undefined) query.set("cursor", cursor);
    const text = query.toString();
    return call({ method: "GET", path: `${command.path}${text ? `?${text}` : ""}` });
  };
  if (!command.follow) return page(command.from);
  const show = context.json ? (item) => context.out(JSON.stringify(item)) : (item) => context.out(logLine(item));
  let from = command.from;
  let first = true;
  for (;;) {
    const items = [];
    let cursor;
    do {
      const answer = await page(from, cursor);
      items.push(...(answer.items ?? []));
      cursor = first || answer.nextCursor === null || answer.nextCursor === undefined ? undefined : String(answer.nextCursor);
    } while (cursor !== undefined && !context.signal?.aborted);
    first = false;
    for (const item of items.reverse()) show(item);
    const newest = Math.max(...items.map((item) => item.timestamp).filter(Number.isFinite));
    if (Number.isFinite(newest)) from = newest + 1;
    if (context.signal?.aborted) return null;
    await wait(context.pollMs ?? 3000);
  }
}

// Waits for a deployment to end, and fails unless it is serving.
async function settle(deploymentId, context, call, checkDeadline) {
  for (;;) {
    const deployment = await call({ method: "GET", path: `/v1/deploy/deployments/${encodeURIComponent(deploymentId)}` });
    if (DEPLOYMENT_DONE.has(deployment.state)) {
      if (deployment.state !== "ready") throw new CliError(`Deployment ${deploymentId} ${deployment.state}${deployment.errorCode ? ` (${deployment.errorCode})` : ""}. Inspect it with mdrn deploy get ${deploymentId}.`);
      return deployment;
    }
    checkDeadline();
    await wait(context.pollMs ?? 2000);
  }
}

function live(context, deployment, result) {
  if (context.json) return result;
  context.out(`Live: ${deployment.hostname ? `https://${deployment.hostname}` : "(no hostname)"} (deployment ${deployment.id})`);
  return null;
}

// The directory goes up as a source archive, Deploy builds it, and the build's deployment
// goes live; the build's output is shown as it runs.
async function deploy(command, context, call) {
  const { archive, files, sha256 } = packSource(command.dir);
  context.err(`Packed ${files} files into ${(archive.length / 1e6).toFixed(2)} MB`);
  const key = (step) => `${command.idempotencyKey.slice(0, 110)}-${step}`;
  const upload = await call({ method: "POST", path: "/v1/deploy/uploads", body: { serviceId: command.serviceId, kind: "source_archive", bytes: archive.length, sha256 }, idempotencyKey: key("upload") });
  await put(upload, archive, context);
  const source = await call({ method: "POST", path: `/v1/deploy/uploads/${encodeURIComponent(upload.id)}/complete`, body: { sha256 }, idempotencyKey: key("complete") });
  context.err(`Uploaded source ${source.sourceId}`);
  const build = await call({ method: "POST", path: "/v1/deploy/builds", body: { serviceId: command.serviceId, sourceId: source.sourceId }, idempotencyKey: key("build") });
  context.err(`Building ${build.buildId}`);
  const checkDeadline = deadline(command, { hint: `mdrn builds get ${build.buildId}` }, "the build");
  const state = await streamLogs(build.buildId, context, call, true, checkDeadline);
  if (state !== "succeeded") {
    const read = await call({ method: "GET", path: `/v1/deploy/builds/${encodeURIComponent(build.buildId)}` });
    throw new CliError(`Build ${build.buildId} ${state}${read.errorCode ? ` (${read.errorCode})` : ""}.`);
  }
  // The build makes its deployment once it has stored the bundle.
  let deploymentId;
  for (;;) {
    const read = await call({ method: "GET", path: `/v1/deploy/builds/${encodeURIComponent(build.buildId)}` });
    deploymentId = read.deploymentId;
    if (deploymentId) break;
    checkDeadline();
    await wait(context.pollMs ?? 2000);
  }
  context.err(`Publishing ${deploymentId}`);
  const deployment = await settle(deploymentId, context, call, checkDeadline);
  return live(context, deployment, { serviceId: command.serviceId, sourceId: source.sourceId, buildId: build.buildId, deploymentId, state: deployment.state, hostname: deployment.hostname ?? null });
}

// The bytes go with the upload's own capability, never the management token, and only to
// the configured API origin.
async function put(upload, archive, context) {
  const origin = secureOrigin(context.origin ?? "https://api.mdrn.io");
  const path = `/v1/deploy/uploads/${encodeURIComponent(upload.id ?? "")}/content`;
  if (typeof upload.id !== "string" || !safeApiPath(path, origin)) throw new CliError("Deploy answered the upload without a usable ID");
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/octet-stream" });
  for (const [name, value] of Object.entries(upload.headers ?? {})) headers.set(name, String(value));
  const fetcher = context.fetcher ?? globalThis.fetch;
  return readResponse(await fetcher(origin.replace(/\/$/, "") + path, { method: "PUT", headers, body: archive, redirect: "error", signal: AbortSignal.timeout(UPLOAD_MS) }));
}

// Rolling back publishes an artifact that served before, as a new deployment.
async function publish(command, context, call) {
  const accepted = await call({ method: "POST", path: "/v1/deploy/deployments", body: command.body, idempotencyKey: command.idempotencyKey });
  context.err(`Publishing ${accepted.deploymentId}`);
  const deployment = await settle(accepted.deploymentId, context, call, deadline(command, { hint: `mdrn deploy get ${accepted.deploymentId}` }, "the deployment"));
  return live(context, deployment, { serviceId: command.body.serviceId, artifactId: command.body.artifactId, deploymentId: accepted.deploymentId, state: deployment.state, hostname: deployment.hostname ?? null });
}

// A repository is named as on GitHub; Deploy knows it by the installation that can see it.
async function connect(command, call) {
  const wanted = command.repository.toLowerCase();
  const installations = await call({ method: "GET", path: "/v1/deploy/github/installations" });
  for (const installation of installations.items ?? []) {
    const repositories = await call({ method: "GET", path: `/v1/deploy/github/repositories?installationId=${encodeURIComponent(installation.id)}` });
    const found = (repositories.items ?? []).find((item) => String(item.repository).toLowerCase() === wanted);
    if (!found) continue;
    const body = { installationId: String(installation.id), repositoryId: String(found.repositoryId), ...(command.branch ? { branch: command.branch } : {}) };
    return call({ method: "PUT", path: `/v1/deploy/services/${encodeURIComponent(command.serviceId)}/github`, body, idempotencyKey: command.idempotencyKey });
  }
  throw new CliError(`${command.repository} is not a repository GitHub lets MDRN see in this project. Connect GitHub (or grant it the repository) in the console, then run this again.`);
}
