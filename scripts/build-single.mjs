// Bundles the app into one self-contained HTML file (inline CSS and JS), for hosts
// that serve a single page, e.g. a Claude artifact or the Android app.
// Usage: node scripts/build-single.mjs [--standalone] [--offline] [out]
//   --standalone  wrap in a full HTML document (for hosts that don't add their own skeleton)
//   --offline     leave out the server settings: no accounts or crew, data stays on the device (Android app)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const args = process.argv.slice(2);
const standalone = args.includes("--standalone");
const offline = args.includes("--offline");
const out = args.find((a) => !a.startsWith("--")) ?? join(root, "dist", "starkheben-5x5.html");

// Modules in dependency order; their local imports and exports are stripped so they share one scope.
// Used by the Claude page (syncs through the artifact db) and the Android app (--offline).
const MODULES = ["src/config.js", "src/schedule.js", "src/standards.js", "src/program.js", "src/sync.js", "src/backends.js", "src/app.js"];
const scripts = MODULES.map((m) => {
  const source = offline && m === "src/config.js"
    ? `// Offline build: no server, so no accounts or crew.\nexport const SUPABASE = { url: "", key: "" };\n`
    : read(m);
  const code = source
    .replace(/^import \{[\s\S]*?\} from "\.\/[\w-]+\.js";\n/gm, "")
    .replace(/^export /gm, "");
  if (/^import /m.test(code)) throw new Error(`${m}: unexpected import left after bundling`);
  return `// ---- ${m} ----\n${code}`;
}).join("\n");

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
${scripts}
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
