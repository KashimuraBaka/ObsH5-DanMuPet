/**
 * convert-mage-sprites.mjs
 *
 * Converts ALL mage character GIF animation files from ObsH5-DanMuPet
 * into sprite sheets + animations.json entries, all under src/assets/sprites/.
 *
 * Source:  H:/Code/Vue/ObsH5-DanMuPet/public/images/mage/
 * Output:  src/assets/sprites/mage/<Skin>.png
 *          src/assets/sprites/mage/<skin>.json
 *          tests/mage-characters.json  (manifest)
 *
 * Each skin has 5 actions: idle, walk, dance, seat, lie
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = join(__dirname, "..");
const SPRITES_DIR = join(OUT_DIR, "src", "assets", "sprites", "mage");

const MAGE_DIR = "H:/Code/Vue/ObsH5-DanMuPet/public/images/mage/";

/** Actions mapped to kirby-animation-compatible state names */
const ACTION_MAP = [
  { key: "idle",   gif: "idle",   loop: true,  dur: 500, desc: "待机" },
  { key: "walk",   gif: "walk",   loop: true,  dur: 50,  desc: "行走" },
  { key: "dance",  gif: "dance",  loop: true,  dur: 100, desc: "跳舞" },
  { key: "crouch", gif: "seat",   loop: false, dur: 80,  desc: "坐下" },
  { key: "lie",    gif: "lie",    loop: false, dur: 80,  desc: "躺下" },
];

/** All skin variants */
const SKINS = [
  "angry", "basic", "blanket", "dizzy", "drowsy",
  "egg", "glummy", "happy", "mage", "sad",
  "scooter", "shy", "sunglass", "twinkle",
];

async function extractFrames(gifPath) {
  const frames = [];
  let page = 0;
  while (true) {
    try {
      const frameBuf = await sharp(gifPath, { page }).png().toBuffer();
      const meta = await sharp(frameBuf).metadata();
      frames.push({ buf: frameBuf, width: meta.width, height: meta.height });
      page++;
      if (page > 100) break;
    } catch { break; }
  }
  return frames;
}

async function convertSkin(skinName) {
  console.log(`\n=== ${skinName} ===`);
  const actions = ACTION_MAP.map(a => ({ ...a, gifFile: `${skinName}_${a.gif}.gif` }));
  const allFrames = [];
  const animData = {};

  for (const action of actions) {
    const gifPath = MAGE_DIR + action.gifFile;
    if (!existsSync(gifPath)) { console.log(`  SKIP ${action.gifFile}`); continue; }
    console.log(`  Extracting ${action.gifFile}...`);
    const frames = await extractFrames(gifPath);
    console.log(`    ${frames.length} frames, each ${frames[0]?.width}x${frames[0]?.height}`);
    const entry = {
      key: action.key, loop: action.loop, dur: action.dur, desc: action.desc,
      frameCount: frames.length, frames: frames.map(f => ({ buf: f.buf, width: f.width, height: f.height })),
    };
    animData[action.key] = entry;
    allFrames.push(...entry.frames.map(f => ({ ...f, action: action.key })));
  }

  if (allFrames.length === 0) { console.log(`  NO FRAMES for ${skinName}`); return null; }

  const cols = 20;
  const rows = Math.ceil(allFrames.length / cols);
  let maxW = 0, maxH = 0;
  for (const f of allFrames) { if (f.width > maxW) maxW = f.width; if (f.height > maxH) maxH = f.height; }
  console.log(`  Sheet: ${cols}x${rows}, padded to ${maxW}x${maxH}`);

  const GAP = 2;
  const sheetW = cols * (maxW + GAP) + GAP;
  const sheetH = rows * (maxH + GAP) + GAP;
  const composites = [];
  let frameNum = 0;

  for (const action of actions) {
    const entry = animData[action.key];
    if (!entry) continue;
    for (let i = 0; i < entry.frames.length; i++) {
      const f = entry.frames[i];
      const col = frameNum % cols;
      const row = Math.floor(frameNum / cols);
      const x = col * (maxW + GAP) + GAP;
      const y = row * (maxH + GAP) + GAP;
      composites.push({ input: f.buf, top: y, left: x });
      f.spriteX = x; f.spriteY = y; f.spriteW = f.width; f.spriteH = f.height;
      const p = skinName.charAt(0).toUpperCase() + skinName.slice(1);
      f.name = `${p}_${frameNum}`;
      entry.frames[i] = f;
      frameNum++;
    }
  }

  const sheetBuf = await sharp({
    create: { width: sheetW, height: sheetH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(composites).png().toBuffer();

  const skinPascal = skinName.charAt(0).toUpperCase() + skinName.slice(1);
  writeFileSync(join(SPRITES_DIR, `${skinPascal}.png`), sheetBuf);
  console.log(`  Saved ${skinPascal}.png (${sheetBuf.length} bytes)`);

  const animationsJson = {
    imageSize: { width: sheetW, height: sheetH },
    globalSpeed: 1.0,
    animations: {},
  };
  for (const action of actions) {
    const entry = animData[action.key];
    if (!entry) continue;
    animationsJson.animations[action.key] = {
      frames: entry.frames.map(f => ({ name: f.name, x: f.spriteX, y: f.spriteY, w: f.spriteW, h: f.spriteH })),
      frameDurationMs: entry.dur, loop: entry.loop, defaultFacing: "left", description: entry.desc,
    };
  }
  writeFileSync(join(SPRITES_DIR, `${skinName}.json`), JSON.stringify(animationsJson, null, 2), "utf-8");
  console.log(`  Saved ${skinName}.json`);

  return {
    name: skinName, sheet: `${skinPascal}.png`, json: `${skinName}.json`,
    animations: Object.keys(animationsJson.animations), imageSize: { width: sheetW, height: sheetH },
  };
}

async function main() {
  mkdirSync(SPRITES_DIR, { recursive: true });
  const manifest = [];
  for (const skinName of SKINS) {
    const result = await convertSkin(skinName);
    if (result) manifest.push(result);
  }
  writeFileSync(join(OUT_DIR, "tests", "mage-characters.json"), JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`\n=== Processed ${manifest.length} skins ===`);
  for (const m of manifest) console.log(`  ${m.name}: ${m.animations.join(", ")}`);
}

main().catch(err => { console.error(err); process.exit(1); });
