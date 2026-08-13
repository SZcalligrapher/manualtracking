import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist-mini");
const output = join(root, "manual-tracking-mini-tool.zip");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "assets"), { recursive: true });
await cp(join(root, "mini-index.html"), join(dist, "index.html"));
for (const file of ["styles.css", "finger-tracking.js", "app.js", "mini.js"]) {
  await cp(join(root, "assets", file), join(dist, "assets", file));
}

const files = ["index.html", "assets/styles.css", "assets/finger-tracking.js", "assets/app.js", "assets/mini.js"];
const prohibited = [
  /https?:\/\//i,
  /fetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket/,
  /EventSource/,
  /getUserMedia/,
  /new\s+Worker/,
  /ServiceWorker/,
  /window\.open/,
  /navigator\.clipboard/,
  /createObjectURL/,
  /\.download\s*=/,
  /<script(?![^>]*\bsrc=)/i,
  /\son\w+\s*=/i,
];

const failures = [];
for (const file of files) {
  const text = await readFile(join(dist, file), "utf8");
  for (const rule of prohibited) if (rule.test(text)) failures.push(`${file}: ${rule}`);
}
if (failures.length) throw new Error(`Mini-tool audit failed:\n${failures.join("\n")}`);

await rm(output, { force: true });
execFileSync("zip", ["-q", "-r", output, "."], { cwd: dist });
const report = [
  "Manual Tracking mini-tool validation",
  "status: PASS",
  `files: ${files.length}`,
  "entry: index.html",
  "network: none",
  "inline-script: none",
  "prohibited-api matches: 0",
  `artifact: ${output}`,
].join("\n");
await writeFile(join(root, "mini-tool-validation.txt"), `${report}\n`);
console.log(report);
