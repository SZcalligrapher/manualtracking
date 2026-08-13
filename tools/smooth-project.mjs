import fs from "node:fs";
import path from "node:path";
import { smoothTrackingKeyframes } from "../assets/app.js";

const [inputPath, outputPath, thresholdArg = "0.02"] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("Usage: node tools/smooth-project.mjs <input.json> <output.json> [threshold]");
  process.exit(1);
}

const project = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const threshold = Math.min(.08, Math.max(.005, Number(thresholdArg) || .02));
const result = smoothTrackingKeyframes(project.keyframes || [], {
  enabled: true,
  threshold,
  maxGap: Math.max(1, Math.ceil((Number(project.fps) || 30) / 5)),
});

project.trackingSmoothingEnabled = true;
project.trackingSmoothingThreshold = threshold;
project.trackingSmoothingProcessedAt = new Date().toISOString();
project.trackingSmoothingSource = path.basename(inputPath);

fs.writeFileSync(outputPath, `${JSON.stringify(project, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, threshold, ...result }));
