// Screenshots of the mockups at 390 and 1280 px, deviceScaleFactor 2.
// Run: node docs/design/calendar-k6/shoot.mjs   (needs Playwright + Chromium; no environment prefix)
import { readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

function loadPlaywright() {
  try { return createRequire(import.meta.url)("playwright"); } catch {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return createRequire(join(root, "noop.js"))("playwright");
  }
}
const { chromium } = loadPlaywright();
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "screenshots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const report = [];
for (const file of readdirSync(here).filter((f) => /^\d\d-.*\.html$/.test(f)).sort()) {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(join(here, file)).href);
    // The check the mockup must pass: no horizontal page scroll, 16 px inputs.
    const facts = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      smallInputs: [...document.querySelectorAll("input,select,textarea")].filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).length,
    }));
    const name = file.replace(/\.html$/, `-${width}.png`);
    await page.screenshot({ path: join(out, name), fullPage: true });
    report.push(`${name}\toverflow=${facts.overflow}px\tinputs<16px=${facts.smallInputs}`);
    await page.close();
  }
}
await browser.close();
console.log(report.join("\n"));
