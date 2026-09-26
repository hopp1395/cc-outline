// Turns SVG frames into an animated GIF: headless Chrome renders each frame to
// a PNG, gifenc encodes them. Set CHROME to the browser binary if it is not
// found in the usual places.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import gifenc from "gifenc";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome() {
  const chrome = process.env.CHROME || CHROME_PATHS.find((p) => existsSync(p));
  if (!chrome) throw new Error("Chrome not found; set CHROME to the browser binary");
  return chrome;
}

/** Renders one SVG to a PNG with a transparent background (for the rounded corners). */
function screenshot(chrome, svgFile, pngFile, width, height) {
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--default-background-color=00000000",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      `--screenshot=${pngFile}`,
      pathToFileURL(svgFile).href,
    ],
    { stdio: "ignore" },
  );
}

/**
 * Writes `frames` ({ svg, duration } with duration in ms) as a looping GIF.
 * Each frame gets its own 256-color palette; transparent pixels stay transparent.
 */
export function writeGif(frames, { width, height }, outFile) {
  const chrome = findChrome();
  const dir = mkdtempSync(join(tmpdir(), "cco-gif-"));
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const gif = GIFEncoder();
  try {
    frames.forEach((frame, i) => {
      const svgFile = join(dir, `${i}.svg`);
      const pngFile = join(dir, `${i}.png`);
      writeFileSync(svgFile, frame.svg);
      screenshot(chrome, svgFile, pngFile, w, h);
      const png = PNG.sync.read(readFileSync(pngFile));
      const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
      const palette = quantize(rgba, 256, { format: "rgba4444", oneBitAlpha: true });
      const index = applyPalette(rgba, palette, "rgba4444");
      const transparentIndex = palette.findIndex((c) => c[3] === 0);
      gif.writeFrame(index, png.width, png.height, {
        palette,
        delay: frame.duration,
        repeat: 0,
        transparent: transparentIndex >= 0,
        transparentIndex: Math.max(0, transparentIndex),
      });
    });
    gif.finish();
    writeFileSync(outFile, gif.bytes());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
