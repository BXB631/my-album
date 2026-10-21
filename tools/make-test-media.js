const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.join(process.cwd(), '.test-media');
fs.mkdirSync(root, { recursive: true });

const colors = [
  ['#243949', '#517fa4'],
  ['#5b247a', '#1bcedf'],
  ['#c94b4b', '#4b134f'],
  ['#134e5e', '#71b280'],
  ['#42275a', '#734b6d'],
  ['#141e30', '#243b55'],
];

const names = [
  '2026_07_03_19_30_21_IMG_9001.JPG',
  '2026_07_03_19_31_00_IMG_9002.JPG',
  '2026_07_04_10_12_00_IMG_9003.JPG',
  '2026_07_05_08_05_00_IMG_9004.PNG',
  '2026_07_06_15_20_00_IMG_9005.JPG',
  '2026_07_07_18_45_00_IMG_9006.JPG',
];

async function main() {
  for (let i = 0; i < names.length; i += 1) {
    const [from, to] = colors[i];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="${from}"/>
          <stop offset="1" stop-color="${to}"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="900" fill="url(#g)"/>
      <circle cx="${250 + i * 120}" cy="300" r="120" fill="rgba(255,255,255,0.18)"/>
      <text x="70" y="760" font-family="Arial" font-size="84" fill="rgba(255,255,255,0.9)">Test photo ${i + 1}</text>
    </svg>`;

    await sharp(Buffer.from(svg))
      .jpeg({ quality: 88 })
      .toFile(path.join(root, names[i]));
  }

  console.log(`Created ${names.length} test images in ${root}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
