/**
 * Browser integration check: verify the app loads, canvas renders, 
 * and the game runs without console errors.
 */

import { chromium } from "playwright-core";

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
  }
}

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Users\\Kashimura\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const warnings = [];
const failedRequests = [];

page.on("console", (msg) => {
  const type = msg.type();
  const text = msg.text();
  const loc = msg.location();
  // Filter out favicon 404 (harmless)
  const isFavicon404 = text.includes("favicon") ||
    (text.includes("404") && loc?.url?.includes("favicon"));
  if (type === "error" && !isFavicon404) {
    errors.push(text);
  }
  if (type === "warning") {
    warnings.push(text);
  }
});

page.on("pageerror", (err) => {
  errors.push(`[pageerror] ${err.message}`);
});

page.on("response", (response) => {
  if (response.status() >= 400 && !response.url().includes("favicon")) {
    failedRequests.push({
      status: response.status(),
      url: response.url(),
    });
  }
});

try {
  await page.goto("http://127.0.0.1:5174", { waitUntil: "networkidle", timeout: 15000 });
  
  // Wait for the app to initialize
  await page.waitForTimeout(2000);
  
  // Check canvas exists
  const canvasCount = await page.locator("canvas").count();
  console.log(`Canvas elements: ${canvasCount}`);
  assert(canvasCount > 0, "Canvas should exist");
  
  // Check the game is running
  const gameState = await page.evaluate(() => {
    const app = document.querySelector('#app')?._vnode?.component?.appContext;
    return { hasApp: !!app };
  });
  console.log(`App mounted: ${gameState.hasApp}`);
  assert(gameState.hasApp, "Vue app should be mounted");
  
  // Check that the canvas has content (non-zero size)
  const canvasInfo = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    return { width: canvas.width, height: canvas.height };
  });
  console.log(`Canvas size: ${canvasInfo?.width}x${canvasInfo?.height}`);
  assert(canvasInfo && canvasInfo.width > 0 && canvasInfo.height > 0, "Canvas should have non-zero size");
  
  // Let the game run for a few seconds
  await page.waitForTimeout(3000);
  
  // Re-check console errors after game runs
  console.log(`\nErrors:   ${errors.length}`);
  console.log(`Warnings: ${warnings.length}`);
  console.log(`Failed requests: ${failedRequests.length}`);
  
  assert(errors.length === 0, "No console errors");
  assert(failedRequests.length === 0, "No failed requests");
  
  if (errors.length > 0) {
    console.log("\nERRORS:");
    errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }
  if (warnings.length > 0) {
    console.log("\nWARNINGS:");
    warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  }
  if (failedRequests.length > 0) {
    console.log("\nFAILED REQUESTS:");
    failedRequests.forEach((r, i) => console.log(`  ${i + 1}. [${r.status}] ${r.url}`));
  }
  
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Browser check: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log("All checks passed!");
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
} finally {
  await browser.close();
}
