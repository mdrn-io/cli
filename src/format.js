// What a person reads: lists as tables, everything else as one field per line. --json prints
// the API's answer as it is, for scripts.

// Deploy and Platform give times in seconds since the epoch; Logs in milliseconds.
function cell(key, value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number" && /At$/.test(key) && value > 1e9 && value < 1e11) return new Date(value * 1000).toISOString().replace(/\.000Z$/, "Z");
  if (typeof value === "number" && /^timestamp$|From$/.test(key) && value > 1e12 && value < 1e14) return new Date(value).toISOString();
  if (Array.isArray(value) && value.every((item) => typeof item !== "object")) return value.join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replace(/\s+/g, " ");
}

export function table(rows, columns) {
  const keys = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] === null || typeof row[key] !== "object")))].slice(0, 8);
  if (!rows.length) return "(none)";
  const lines = [keys, ...rows.map((row) => keys.map((key) => cell(key, row[key])))];
  const widths = keys.map((_, index) => Math.max(...lines.map((line) => line[index].length)));
  return lines.map((line) => line.map((text, index) => (index === line.length - 1 ? text : text.padEnd(widths[index]))).join("  ")).join("\n");
}

export function human(value, columns) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value, null, 2);
  const fields = [];
  const tables = [];
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) && item.every((row) => row && typeof row === "object" && !Array.isArray(row))) tables.push([key, item]);
    else if (!(key === "nextCursor" && item === null)) fields.push([key, cell(key, item)]);
  }
  const width = Math.max(0, ...fields.map(([key]) => key.length));
  const parts = tables.map(([key, rows]) => (tables.length === 1 && key === "items" ? "" : `${key}:\n`) + table(rows, key === "items" ? columns : undefined));
  // A list leads with its rows; anything else with its own fields.
  if (fields.length) parts.splice(Array.isArray(value.items) ? parts.length : 0, 0, fields.map(([key, text]) => `${key.padEnd(width)}  ${text}`).join("\n"));
  return parts.join("\n\n");
}
