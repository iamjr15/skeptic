import fs from "node:fs";
import path from "node:path";

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  // Fallback for punctuation-only or non-ASCII inputs. Also neutralizes path
  // separators — safe to use as a filename.
  return base || "flow";
}

export function uniqueSlug(name: string, dir: string): string {
  const base = slugify(name);
  if (!fs.existsSync(path.join(dir, `${base}.yaml`))) return base;

  let n = 2;
  while (fs.existsSync(path.join(dir, `${base}-${n}.yaml`))) n++;
  return `${base}-${n}`;
}
