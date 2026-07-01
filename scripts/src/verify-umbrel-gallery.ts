/**
 * Verify the Umbrel app-store gallery assets.
 *
 * The Umbrel UI renders the app-store listing (icon + gallery screenshots) from
 * the packaging bundle: `umbrel-app.yml` plus the gallery images that ship
 * alongside it. If a gallery file is missing, empty, or the wrong size, the
 * Umbrel UI silently falls back to a broken image. This script fails the
 * release when that would happen.
 *
 * It runs against a directory that holds both the manifest and its gallery
 * images. That directory is either the source tree (`umbrel/`) for a fast
 * pre-build check, or the assets extracted from the built Docker image
 * (`/app/umbrel-store`) for a post-`docker build` check that the files were
 * actually packaged. Pass the directory as the first CLI argument (or via the
 * `UMBREL_ASSET_DIR` env var); it defaults to the source `umbrel/` directory.
 *
 * Checks performed against every gallery image referenced by `umbrel-app.yml`:
 *   - `umbrel-app.yml` exists and is readable.
 *   - Each referenced gallery image resolves to a real file in the same
 *     directory as `umbrel-app.yml`.
 *   - Each gallery image is a non-zero-byte, readable JPEG/PNG.
 *   - Each gallery image is exactly 1280x800 (Umbrel's required gallery size).
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXPECTED_WIDTH = 1280;
const EXPECTED_HEIGHT = 800;
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultUmbrelDir = path.resolve(scriptDir, "..", "..", "umbrel");
const targetDir = process.argv[2] ?? process.env.UMBREL_ASSET_DIR ?? "";
const umbrelDir = targetDir ? path.resolve(targetDir) : defaultUmbrelDir;
const manifestPath = path.join(umbrelDir, "umbrel-app.yml");

const errors: string[] = [];
const passed: string[] = [];

/** Read the width/height of a PNG or JPEG from its header bytes. */
function readImageDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR chunk with width/height as big-endian u32.
  const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  // JPEG: starts with SOI (0xFFD8). Walk the marker segments until a
  // Start-Of-Frame marker (SOF0-SOF15, excluding DHT/JPG/DAC/RSTn), which
  // carries the height (u16) then width (u16).
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      // Every marker begins with 0xFF; skip fill bytes.
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // Standalone markers (no length): RSTn (0xD0-0xD7), SOI, EOI, TEM.
      if (
        (marker >= 0xd0 && marker <= 0xd9) ||
        marker === 0x01 ||
        marker === 0xff
      ) {
        offset += 2;
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      const isSOF =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 && // DHT
        marker !== 0xc8 && // JPG
        marker !== 0xcc; // DAC
      if (isSOF) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + segmentLength;
    }
  }

  return null;
}

/** Extract gallery image references from the (simple, flat) umbrel-app.yml. */
function parseGalleryReferences(manifest: string): string[] {
  const lines = manifest.split(/\r?\n/);
  const references: string[] = [];
  let inGallery = false;

  for (const line of lines) {
    if (/^gallery:\s*$/.test(line)) {
      inGallery = true;
      continue;
    }
    if (!inGallery) continue;

    // Gallery list items are indented "  - <value>". A non-indented,
    // non-list line ends the gallery block.
    const itemMatch = line.match(/^\s+-\s+(.+?)\s*$/);
    if (itemMatch) {
      references.push(itemMatch[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) break;
  }

  return references;
}

function fail(message: string): void {
  errors.push(message);
}

function ok(message: string): void {
  passed.push(message);
}

// 1. Manifest must exist and be readable.
let manifest: string;
try {
  manifest = readFileSync(manifestPath, "utf8");
  ok(`Found manifest: ${path.relative(process.cwd(), manifestPath)}`);
} catch {
  fail(`Cannot read umbrel-app.yml at ${manifestPath}`);
  report();
  process.exit(1);
}

// 2. Collect gallery image references.
const references = parseGalleryReferences(manifest);
const imageReferences = references.filter((ref) =>
  IMAGE_EXTENSIONS.includes(path.extname(ref).toLowerCase()),
);

if (imageReferences.length === 0) {
  fail(
    "No gallery images found in umbrel-app.yml (expected at least one JPEG/PNG under `gallery:`)",
  );
}

// 3. Validate each referenced gallery image against the local packaging asset.
for (const ref of imageReferences) {
  const basename = path.basename(ref.split(/[?#]/)[0]);
  const localPath = path.join(umbrelDir, basename);
  const displayPath = path.relative(process.cwd(), localPath);

  let stat;
  try {
    stat = statSync(localPath);
  } catch {
    fail(
      `Gallery image "${ref}" -> "${basename}" is missing from the packaging bundle (expected alongside umbrel-app.yml at ${displayPath})`,
    );
    continue;
  }

  if (!stat.isFile()) {
    fail(`Gallery image "${displayPath}" is not a regular file`);
    continue;
  }

  if (stat.size === 0) {
    fail(`Gallery image "${displayPath}" is zero bytes`);
    continue;
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(localPath);
  } catch {
    fail(`Gallery image "${displayPath}" is not readable`);
    continue;
  }

  const dimensions = readImageDimensions(buffer);
  if (!dimensions) {
    fail(
      `Gallery image "${displayPath}" is not a recognizable JPEG/PNG (could not read dimensions)`,
    );
    continue;
  }

  if (
    dimensions.width !== EXPECTED_WIDTH ||
    dimensions.height !== EXPECTED_HEIGHT
  ) {
    fail(
      `Gallery image "${displayPath}" is ${dimensions.width}x${dimensions.height}, expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`,
    );
    continue;
  }

  ok(
    `Gallery image "${displayPath}" OK (${stat.size} bytes, ${dimensions.width}x${dimensions.height})`,
  );
}

report();
process.exit(errors.length > 0 ? 1 : 0);

function report(): void {
  for (const line of passed) console.log(`  \u2713 ${line}`);
  for (const line of errors) console.error(`  \u2717 ${line}`);
  if (errors.length > 0) {
    console.error(
      `\nUmbrel gallery verification FAILED with ${errors.length} error(s).`,
    );
  } else {
    console.log("\nUmbrel gallery verification passed.");
  }
}
