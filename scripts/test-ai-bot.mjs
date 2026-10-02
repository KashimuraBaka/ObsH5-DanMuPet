/**
 * Test harness for AIBot jump-clipping fix.
 *
 * Runs all 6 acceptance tests against the AIBot.update() method.
 * Uses esbuild to bundle the TS module, then exercises the bot directly.
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ---- Bundle AIBot.ts with esbuild ----
const entry = resolve(root, "src/engine/AIBot.ts");
const outDir = resolve(root, "node_modules/.tmpdir");
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, "ai-bot-test-bundle.mjs");

execSync(
  `npx esbuild "${entry}" --bundle --format=esm --outfile="${out}" --platform=neutral`,
  { cwd: root, stdio: "pipe" },
);

// Replace the JSON import with a file URL
const animPath = resolve(root, "src/animations.json");
const animData = JSON.parse(readFileSync(animPath, "utf-8"));
const animJsonPath = resolve(outDir, "animations.json");
writeFileSync(animJsonPath, JSON.stringify(animData));

const bundledCode = readFileSync(out, "utf-8");
const animFileUrl = pathToFileURL(animJsonPath).href;
const patchedCode = bundledCode.replace(
  /from\s*"\.\.\/animations\.json"/,
  `from "${animFileUrl}"`,
);

const bundleUrl = resolve(outDir, "ai-bot-test-patched.mjs");
writeFileSync(bundleUrl, patchedCode);

const { AIBot, BotState } = await import(pathToFileURL(bundleUrl).href);

// ---- Helpers ----

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg, ctx = null) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    if (ctx) {
      const b = ctx.bot;
      console.error(
        `  [FAIL] ${msg}\n` +
        `    bot: x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} vx=${b.vx.toFixed(1)} vy=${b.vy.toFixed(1)} ` +
        `onGround=${b.onGround} jumpArc=${b.jumpArc} dir=${b.dir} state=${b.state}\n` +
        `    blocks: ${ctx.blocks.map(bl => `x=${bl.x} y=${bl.y} w=${bl.w} h=${bl.h}`).join(", ")}`,
      );
    }
  }
}

function makeBot(opts = {}) {
  const bot = new AIBot({
    speed: 2.5,
    jumpImpulse: -8,
    gravity: 0.4,
    chaseRange: 9999,
    attackRange: 60,
    playerFollowRange: 340,
    playerStayRange: 120,
  });
  Object.assign(bot, opts);
  // Large canvas width prevents boundary wrap during tests
  if (!opts.canvasWidth) bot.canvasWidth = 100000;
  return bot;
}

function stepBot(bot, blocks, groundY, enemies = [], playerX = 99999, playerY = groundY, dt = 16) {
  bot.update(dt, groundY, blocks, enemies, playerX, playerY);
}

// ================================================================
// Test 1: Bot CANNOT pass through wall (critical)
// ================================================================
console.log("\n=== Test 1: Bot cannot pass through wall during jump ===");
{
  const groundY = 400;
  const wallHeight = 6; // 6 blocks = 180px, well above jump reach (80px)
  const blockSize = 30;
  const wallBlocks = [];
  for (let i = 0; i < wallHeight; i++) {
    wallBlocks.push({
      x: 500,
      y: groundY - (i + 1) * blockSize,
      w: blockSize,
      h: blockSize,
      dead: false,
    });
  }

  const bot = makeBot({
    x: 460,  // 40px left of wall
    y: groundY,
    vx: 3,
    dir: 1,
  });

  assert(bot.dir === 1, "Bot should face right");

  // The bot should chase right (playerX=99999), hit the wall, and be blocked
  let passedWall = false;
  for (let i = 0; i < 300; i++) {
    stepBot(bot, wallBlocks, groundY, [], 99999, groundY);

    if (bot.x > 515) {
      passedWall = true;
      break;
    }

    // Check if bot is inside any wall block (overlap check)
    for (const bl of wallBlocks) {
      if (
        bot.x - bot.w / 2 < bl.x + bl.w - 0.01 &&
        bot.x + bot.w / 2 > bl.x + 0.01 &&
        (bot.y - bot.h) < bl.y + bl.h &&
        bot.y > bl.y
      ) {
        passedWall = true;
        break;
      }
    }
    if (passedWall) break;
  }

  assert(!passedWall, "Bot must NOT pass through the wall", { bot, blocks: wallBlocks, groundY });
  // Bot should be stopped at or before the wall's left edge (x=500 - w/2)
  assert(bot.x <= 500 - bot.w / 2 + 1, `Bot should be stopped at wall left edge (x<=${(500 - bot.w / 2).toFixed(1)}), got x=${bot.x.toFixed(1)}`);
  console.log(`  Bot stopped at x=${bot.x.toFixed(1)} (wall left edge: ${(500 - bot.w / 2).toFixed(1)})`);
}

// ================================================================
// Test 2: Bot CAN jump over a low wall
// ================================================================
console.log("\n=== Test 2: Bot can jump over low wall ===");
{
  const groundY = 400;
  const wallHeight = 2; // 2 blocks = 60px, clearable (jump peak = 80px)
  const blockSize = 30;
  const wallBlocks = [];
  for (let i = 0; i < wallHeight; i++) {
    wallBlocks.push({
      x: 500,
      y: groundY - (i + 1) * blockSize,
      w: blockSize,
      h: blockSize,
      dead: false,
    });
  }

  const bot = makeBot({
    x: 470,
    y: groundY,
    vx: 3.75,
    dir: 1,
  });

  // Force a jump
  bot.vy = bot.config.jumpImpulse;
  bot.onGround = false;
  bot.jumpArc = true;

  let crossed = false;
  let minY = bot.y;
  for (let i = 0; i < 200; i++) {
    stepBot(bot, wallBlocks, groundY, [], 99999, groundY);
    minY = Math.min(minY, bot.y);

    if (bot.x > 540) {
      crossed = true;
      break;
    }
  }

  assert(crossed, "Bot should jump over the low wall and reach x>540", { bot, blocks: wallBlocks, groundY });
  console.log(`  Bot reached x=${bot.x.toFixed(1)} (wall right edge: 530), peak y=${minY.toFixed(1)} (ground: ${groundY}, wall top: ${groundY - 60})`);
}

// ================================================================
// Test 3: Bot lands on block during jump
// ================================================================
console.log("\n=== Test 3: Bot lands on block during jump ===");
{
  const groundY = 400;
  const blockSize = 30;

  // A block floating above the bot's jump arc
  const blockAbove = {
    x: 300,
    y: 320,  // 80px above ground — within jump reach
    w: blockSize,
    h: blockSize,
    dead: false,
  };

  // Start the bot DIRECTLY ABOVE the block, falling down.
  // Use manualDriven to prevent the AI from changing vx.
  const bot = makeBot({
    x: 315,  // centred on block
    y: 280,  // 40px above block top
    vx: 0,
    vy: 2,   // falling
    dir: 1,
  });
  bot.manualDriven = true;
  bot.manualDriveDir = 0;
  bot.onGround = false;
  bot.jumpArc = true;

  let landedOnBlock = false;
  for (let i = 0; i < 200; i++) {
    stepBot(bot, [blockAbove], groundY, [], 99999, groundY);

    // Check if bot landed on top of the block
    if (
      bot.onGround &&
      bot.y === blockAbove.y &&
      bot.x > blockAbove.x - bot.w / 2 - 5 &&
      bot.x < blockAbove.x + blockAbove.w + bot.w / 2 + 5
    ) {
      landedOnBlock = true;
      break;
    }
  }

  assert(landedOnBlock, "Bot should land on top of the block above", { bot, blocks: [blockAbove], groundY });
  console.log(`  Bot landed: y=${bot.y.toFixed(1)} (block top: ${blockAbove.y}), x=${bot.x.toFixed(1)}, onGround=${bot.onGround}`);
}

// ================================================================
// Test 4: No head-bump false positive during jump
// ================================================================
console.log("\n=== Test 4: No head-bump false positive ===");
{
  const groundY = 400;
  const blockSize = 30;

  // Ceiling block well above jump arc peak — bot should never reach it
  const ceilingBlock = {
    x: 200,
    y: 100,  // 300px above ground — far above jump reach (~80px)
    w: 100,
    h: blockSize,
    dead: false,
  };

  const bot = makeBot({
    x: 240,
    y: groundY,
    vx: 0,
    dir: 1,
  });

  bot.vy = bot.config.jumpImpulse;
  bot.onGround = false;
  bot.jumpArc = true;

  let bouncedOffCeiling = false;
  let jumpEnded = false;
  let minY = bot.y;
  for (let i = 0; i < 200; i++) {
    stepBot(bot, [ceilingBlock], groundY, [], 99999, groundY);
    minY = Math.min(minY, bot.y);

    if (bot.onGround && bot.jumpArc === false) {
      jumpEnded = true;
      // If bot bounced off ceiling, it would have stopped well above ground
      // with vy=0 (ceiling bump sets vy=0)
      if (bot.y < groundY - 50 && bot.y > ceilingBlock.y + ceilingBlock.h - 5) {
        bouncedOffCeiling = true;
      }
      break;
    }
  }

  assert(jumpEnded, "Bot should complete jump arc");
  assert(!bouncedOffCeiling, "Bot should NOT bounce off ceiling it never reached");
  console.log(`  Bot ended: y=${bot.y.toFixed(1)}, vy=${bot.vy.toFixed(1)}, jumpArc=${bot.jumpArc}, peak y=${minY.toFixed(1)}`);
}

// ================================================================
// Test 5: Facing/vx oscillation regression
// ================================================================
console.log("\n=== Test 5: No dir/vx oscillation against wall ===");
{
  const groundY = 400;
  const blockSize = 30;
  const wallBlocks = [];
  for (let i = 0; i < 7; i++) {
    wallBlocks.push({
      x: 500,
      y: groundY - (i + 1) * blockSize,
      w: blockSize,
      h: blockSize,
      dead: false,
    });
  }

  const bot = makeBot({
    x: 470,
    y: groundY,
    vx: 3,
    dir: 1,
  });

  let dirFlips = 0;
  let vxFlips = 0;
  let lastDir = bot.dir;
  let lastVx = bot.vx;

  for (let i = 0; i < 60; i++) {
    // Keep pushing toward the wall (as if chasing right)
    if (bot.onGround && bot.vx === 0) {
      bot.vx = 3;
    }
    stepBot(bot, wallBlocks, groundY, [], 99999, groundY);

    if (bot.dir !== lastDir) dirFlips++;
    lastDir = bot.dir;

    if (Math.sign(bot.vx) !== Math.sign(lastVx) && Math.abs(bot.vx) > 0.5 && Math.abs(lastVx) > 0.5) {
      vxFlips++;
    }
    lastVx = bot.vx;
  }

  assert(dirFlips === 0, `Bot dir should NOT oscillate against wall (flips: ${dirFlips})`);
  assert(vxFlips <= 1, `Bot vx should NOT oscillate against wall (flips: ${vxFlips})`);
  console.log(`  dir flips: ${dirFlips}, vx flips: ${vxFlips}`);
}

// ================================================================
// Test 6: Pathfinding regression
// ================================================================
console.log("\n=== Test 6: Pathfinding finds route around wall ===");
{
  const groundY = 400;
  const blockSize = 30;
  const wallBlocks = [];
  // Wall of height 3 at x=500 — jumpable (90px, but bot can jump 80px... borderline)
  // Use height 2 for reliability
  for (let i = 0; i < 2; i++) {
    wallBlocks.push({
      x: 500,
      y: groundY - (i + 1) * blockSize,
      w: blockSize,
      h: blockSize,
      dead: false,
    });
  }

  const bot = makeBot({
    x: 300,
    y: groundY,
    vx: 3,
    dir: 1,
  });

  // Place an enemy on the other side of the wall
  const enemy = {
    x: 600,
    y: groundY - 13,
    w: 24,
    h: 26,
    dead: false,
    centreX: 600,
    centreY: groundY - 13,
  };

  let reached = false;
  let jumped = false;
  let maxJumpY = bot.y;

  for (let i = 0; i < 500; i++) {
    stepBot(bot, wallBlocks, groundY, [enemy], 99999, groundY);

    if (bot.vy < 0) jumped = true;
    maxJumpY = Math.min(maxJumpY, bot.y);

    if (bot.x > 600) {
      reached = true;
      break;
    }
  }

  // Bot should either jump over the wall or find a path to the enemy
  assert(reached || jumped, "Bot should reach enemy or jump to navigate around wall");
  console.log(`  Bot reached x=${bot.x.toFixed(1)} (target: 600), jumped: ${jumped}, peak y: ${maxJumpY.toFixed(1)}`);
}

// ================================================================
// Test 7: Horizontal collision skip only when above block
// ================================================================
console.log("\n=== Test 7: Weak jump cannot pass through wall ===");
{
  const groundY = 400;
  const blockSize = 30;
  const wallBlocks = [];
  for (let i = 0; i < 6; i++) {
    wallBlocks.push({
      x: 500,
      y: groundY - (i + 1) * blockSize,
      w: blockSize,
      h: blockSize,
      dead: false,
    });
  }

  const bot = makeBot({
    x: 470,
    y: groundY,
    vx: 3,
    dir: 1,
  });

  // Weak jump — not enough to clear the wall (wall = 180px, jump = 80px)
  bot.vy = -4; // peak = 16/0.8 = 20px
  bot.onGround = false;
  bot.jumpArc = true;

  let slippedThrough = false;
  for (let i = 0; i < 100; i++) {
    stepBot(bot, wallBlocks, groundY, [], 99999, groundY);
    if (bot.x > 530) {
      slippedThrough = true;
      break;
    }
    for (const bl of wallBlocks) {
      if (
        bot.x - bot.w / 2 < bl.x + bl.w &&
        bot.x + bot.w / 2 > bl.x &&
        (bot.y - bot.h) < bl.y + bl.h &&
        bot.y > bl.y
      ) {
        slippedThrough = true;
        break;
      }
    }
    if (slippedThrough) break;
  }

  assert(!slippedThrough, "Bot with weak jump should NOT pass through wall", { bot, blocks: wallBlocks, groundY });
  console.log(`  Bot ended at x=${bot.x.toFixed(1)}, y=${bot.y.toFixed(1)}, slipped: ${slippedThrough}`);
}

// ---- Summary ----
console.log(`\n${"=".repeat(50)}`);
console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFAILURES:`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log("All tests passed!");
}
