import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { imageDimensions } from "./build-site.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_ROOTS = ["assets", "images", "opportunities"];
const RASTER_EXTENSIONS = new Set([".jpeg", ".jpg", ".png"]);
const WIDTHS = [480, 960, 1440];

function walk(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(filePath));
    else if (entry.isFile() && RASTER_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(filePath);
  }
  return found;
}

function convert(sourcePath, outputPath, width) {
  const args = ["-quiet", "-q", "78", "-m", "6"];
  if (width) args.push("-resize", String(width), "0");
  args.push(sourcePath, "-o", outputPath);
  const result = spawnSync("cwebp", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cwebp failed for ${path.relative(ROOT, sourcePath)}`);
}

let count = 0;
const sources = IMAGE_ROOTS.flatMap((directory) => walk(path.join(ROOT, directory)));
for (const sourcePath of sources) {
  const dimensions = imageDimensions(sourcePath);
  if (!dimensions) throw new Error(`Could not read dimensions for ${path.relative(ROOT, sourcePath)}`);
  const basePath = sourcePath.replace(/\.(?:png|jpe?g)$/i, "");
  const variants = WIDTHS.filter((width) => dimensions.width > width);
  variants.push(dimensions.width);
  for (const width of new Set(variants)) {
    const outputPath = width === dimensions.width ? `${basePath}.webp` : `${basePath}.${width}.webp`;
    convert(sourcePath, outputPath, width === dimensions.width ? null : width);
    count += 1;
  }
}

console.log(`Generated ${count} responsive WebP files from ${sources.length} raster images.`);
