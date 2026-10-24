#!/usr/bin/env node
/**
 * Renders Tower's PNG icons from the SVG masters in public/icons/ (the SVGs are the source of truth):
 *
 *   tower-icon.svg          -> tower-icon-192.png, tower-icon-512.png, tower-icon-maskable-512.png, tower-apple-touch-icon.png (180)
 *   tower-favicon.svg       -> tower-favicon-32.png        (a bolder, simpler mark that survives 32 pixels)
 *   tower-notify-badge.svg  -> tower-notify-badge-96.png   (flat white on transparent, which Android tints for the status bar)
 *
 * The icon is a radar scope, Tower's signature device (docs/mobile-app-design.md): a bezel with tick marks, range rings, a
 * sweep with a fading trail, and blips shaped like the map's markers. Full-bleed and opaque (iOS and Android apply their
 * own corner mask); the scope sits inside the central 80% so the maskable version survives a circular crop.
 *
 * Needs Playwright and a Chromium: `node scripts/render-tower-icons.mjs`, with PLAYWRIGHT_BROWSERS_PATH or
 * CHROMIUM_PATH set if the browser is not where Playwright expects it.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons");
const { chromium } = await import("playwright");

const jobs = [
  ["tower-icon.svg", "tower-icon-192.png", 192],
  ["tower-icon.svg", "tower-icon-512.png", 512],
  ["tower-icon.svg", "tower-icon-maskable-512.png", 512],
  ["tower-icon.svg", "tower-apple-touch-icon.png", 180],
  ["tower-favicon.svg", "tower-favicon-32.png", 32],
  ["tower-notify-badge.svg", "tower-notify-badge-96.png", 96, true],
];

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
for (const [src, out, size, transparent] of jobs) {
  const svg = readFileSync(resolve(root, src), "utf8").replace(/width="512" height="512"/, `width="${size}" height="${size}"`);
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: resolve(root, out), clip: { x: 0, y: 0, width: size, height: size }, omitBackground: !!transparent });
  await page.close();
  console.log(`${src} -> ${out} (${size}px)`);
}
await browser.close();
