/**
 * The handful of small, pure helpers this worker needs from ookaro-api's own
 * src/lib/generalData.js - copied, not imported (this is a separate Node process, and
 * ookaro-api's own module uses Next.js path aliases this project can't resolve). Keep
 * these in sync by hand if the source ever changes - same "copy don't share across
 * processes" reasoning ookaro-api already applies to its own versioned src/v1, src/v2.
 */

/** MySQL DATETIME string: 'YYYY-MM-DD HH:MM:SS' - naive, no timezone conversion. */
export function sqlDateTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export function castConfigValue(value, valueType) {
  if (value === null || value === undefined) return null;
  switch (valueType) {
    case "int":
      return Number.parseInt(value, 10);
    case "decimal":
      return Number.parseFloat(value);
    case "bool":
      return value === "1" || value === 1 || value === "true";
    case "json":
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    default:
      return value;
  }
}

export function renderTemplate(str, vars) {
  if (!str) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ""));
}
