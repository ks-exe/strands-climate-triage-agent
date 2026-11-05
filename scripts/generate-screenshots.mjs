/**
 * Capture the README screenshots against the running app.
 *
 * Prerequisites (three terminals):
 *   npm run dev:api     # local Strands agent API on :8787
 *   npm run dev          # Vite frontend on :5173 (proxies /api to :8787)
 *   npm run screenshots  # this script
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:5173";
const csv = readFileSync("sample-data/sensor_telemetry.csv", "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

console.log(`Loading ${APP_URL} ...`);
await page.goto(APP_URL, { waitUntil: "networkidle" });

console.log("Uploading sample telemetry ...");
await page.locator('input[type="file"]').setInputFiles({
  name: "sensor_telemetry.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(csv)
});

console.log("Waiting for the triage agent verdict ...");
await page.locator(".verdict-chip").waitFor({ state: "visible", timeout: 90_000 });
await page.waitForTimeout(1200); // let the advisory and trail finish rendering

await page.screenshot({ path: "docs/screenshots/dashboard-overview.png", fullPage: true });
console.log("wrote docs/screenshots/dashboard-overview.png");

const agent = page.locator(".agent-panel");
await agent.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await agent.screenshot({ path: "docs/screenshots/agent-reasoning.png" });
console.log("wrote docs/screenshots/agent-reasoning.png");

await browser.close();
