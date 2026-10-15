import { readFileSync } from "node:fs";
import { CliError, CONSOLE_ONLY, CONSOLE_ONLY_NOTE, GROUPS, SPEC, unknown } from "./client.js";

// `mdrn --help` (or -h, or help) lists every command by its first word; `mdrn <group> --help`
// one group; `mdrn --version` the package's version.
export function version() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

const INDENT = 2;
// A usage longer than this puts its summary on the next line rather than widening the column.
const COLUMN = 58;

function render(entries) {
  const left = entries.map((entry) => `${" ".repeat(INDENT)}mdrn ${[entry.name, entry.usage].filter(Boolean).join(" ")}`);
  const width = Math.max(0, ...left.filter((text) => text.length <= COLUMN).map((text) => text.length)) + 2;
  return entries.map((entry, index) => (left[index].length <= COLUMN ? left[index].padEnd(width) + entry.summary : `${left[index]}\n${" ".repeat(width)}${entry.summary}`)).join("\n");
}

const FOOTER = [
  "Scope: --workspace id, --project id, --environment sandbox|production and --service id; or MDRN_WORKSPACE,",
  "  MDRN_PROJECT, MDRN_ENVIRONMENT and MDRN_SERVICE; or the directory's .mdrn/link.json (mdrn link); or the profile.",
  "Options: --json prints the API's answer as it is; --profile name picks a profile; --idempotency-key key makes a",
  "  retried change apply once (every change makes one up otherwise); --help (-h); --version.",
  `Console only: ${CONSOLE_ONLY_NOTE}`,
  `  ${Object.keys(CONSOLE_ONLY).join(", ")} and tokens revoke need a scope a browser sign-in never holds: use the console or a`,
  "  management token (MDRN_API_TOKEN).",
];

export function help(group) {
  if (group === undefined) {
    const sections = [];
    const single = SPEC.filter((entry) => SPEC.filter((other) => other.name.split(" ")[0] === entry.name.split(" ")[0]).length === 1);
    sections.push(`mdrn <command> [options]\n\n${render(single)}`);
    for (const word of GROUPS) {
      const entries = SPEC.filter((entry) => entry.name.split(" ")[0] === word);
      if (entries.length > 1) sections.push(`${word}\n${render(entries)}`);
    }
    return `${sections.join("\n\n")}\n\n${FOOTER.join("\n")}\n\nRun mdrn <group> --help for one group, such as mdrn builds --help.`;
  }
  if (!GROUPS.includes(group)) throw new CliError(unknown([group]), 2);
  return `${render(SPEC.filter((entry) => entry.name.split(" ")[0] === group))}\n\n${FOOTER.slice(0, 2).join("\n")}`;
}

// The next step, added to an error that has one: a credential the API refused, a scope flag
// that is missing, a refusal by scope.
export function advise(error, authType) {
  const message = error.message;
  if (error.status === 401) {
    if (authType === "env") return `${message}. MDRN_API_TOKEN was refused: set a valid management token, or unset it and run mdrn login.`;
    return `${message}. Run mdrn login.`;
  }
  if (/^--(project|environment|service) is required$/.test(message)) return `${message}. Run mdrn link in the app directory, or pass the flag.`;
  if (message === "--workspace is required") return `${message}. Run mdrn login, which stores the workspace, or pass the flag.`;
  return message;
}
