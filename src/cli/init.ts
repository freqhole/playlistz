import * as fs from "node:fs";
import * as path from "node:path";

// these placeholder strings are replaced at build time by build-component.js
// with the actual file contents read from the source tree
const INDEX_HTML = "__INDEX_HTML__";
const SW_JS = "__SW_JS__";

export function initDir(dir: string): void {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });

  fs.writeFileSync(path.join(resolved, "index.html"), INDEX_HTML, "utf-8");
  console.log(`wrote ${path.join(resolved, "index.html")}`);

  fs.writeFileSync(path.join(resolved, "sw.js"), SW_JS, "utf-8");
  console.log(`wrote ${path.join(resolved, "sw.js")}`);
}
