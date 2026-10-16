// Bundles the app into one self-contained HTML file (inline CSS and JS), for hosts
// that serve a single page, e.g. a Claude artifact or the Android app.
// Usage: node scripts/build-single.mjs [--standalone] [out]
//   --standalone  wrap in a full HTML document (for hosts that don't add their own skeleton)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const args = process.argv.slice(2);
const standalone = args.includes("--standalone");
const out = args.find((a) => !a.startsWith("--")) ?? join(root, "dist", "starkheben-5x5.html");

const program = read("src/program.js").replace(/^export /gm, "");
const app = read("src/app.js").replace(/^import \{[\s\S]*?\} from "\.\/program\.js";\n/m, "");
if (app.includes('from "./program.js"')) throw new Error("app.js import block not stripped");

const html = read("index.html");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"))
  .replace(/\s*<script type="module" src="src\/app\.js"><\/script>/, "");

const head = `<title>Starkheben 5×5</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Simple 5x5 barbell strength tracker.">
<style>
${read("src/styles.css")}
</style>`;
const content = `${body.trim()}
<script type="module">
${program}
${app}
</script>`;

// Default output has no doctype/html/head/body: single-page hosts wrap the file in their own skeleton.
const page = standalone
  ? `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
</head>
<body>
${content}
</body>
</html>
`
  : `${head}\n${content}\n`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`Wrote ${out} (${(page.length / 1024).toFixed(1)} KB)`);
