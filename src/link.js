import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, execute } from "./client.js";

// `mdrn link` writes .mdrn/link.json in the current directory, which every later command in it
// (or below it) reads for its --workspace, --project, --environment and --service, so
// `mdrn deploy` alone deploys the directory. The file holds identifiers only, never a credential,
// and may be committed. A selector left out is picked when the workspace has exactly one of it;
// the environment is sandbox unless named.
export const LINK_FILE = join(".mdrn", "link.json");

const show = (items) => items.map((item) => `  ${item.id}  ${item.name ?? ""}`.replace(/\s+$/, "")).join("\n");

async function only(list, what, flag, context, { none, many }) {
  const items = list.items ?? [];
  if (items.length === 1) return items[0].id;
  if (!items.length) throw new CliError(none, 2);
  context.err(`${what}s in this ${many}:\n${show(items)}`);
  throw new CliError(`Pass --${flag} with the ${what} to link`, 2);
}

export async function link(command, context) {
  const call = (request) => execute(request, context);
  const workspace = command.workspace;
  if (!workspace) throw new CliError("--workspace is required (mdrn login stores the workspace you approved)", 2);
  const project = command.project ?? await only(await call({ method: "GET", path: `/v1/platform/projects?workspaceId=${encodeURIComponent(workspace)}` }), "project", "project", context, {
    none: `Workspace ${workspace} has no project; create one in the console (mdrn open project)`, many: "workspace",
  });
  const environment = command.environment ?? "sandbox";
  const service = command.service ?? await only(await call({ method: "GET", path: "/v1/deploy/services", project, environment }), "service", "service", context, {
    none: `Project ${project} has no service in ${environment}; create one with mdrn services create --name app --project ${project} --environment ${environment}`, many: "environment",
  });
  const dir = resolve(context.cwd ?? process.cwd());
  mkdirSync(join(dir, ".mdrn"), { recursive: true });
  const linked = { workspace, project, environment, service };
  writeFileSync(join(dir, LINK_FILE), JSON.stringify(linked, null, 2) + "\n");
  context.err(`Linked ${dir} to project ${project} (${environment}), service ${service}. Next: mdrn deploy`);
  return context.json ? linked : null;
}
