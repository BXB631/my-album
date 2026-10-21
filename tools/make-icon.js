const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');

const svg = `
<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="64" y1="32" x2="448" y2="480" gradientUnits="userSpaceOnUse">
      <stop stop-color="#2C2C31"/>
      <stop offset="0.45" stop-color="#111114"/>
      <stop offset="1" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="frame" x1="112" y1="120" x2="404" y2="404" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#B9B9C3"/>
    </linearGradient>
    <linearGradient id="sky" x1="128" y1="160" x2="384" y2="360" gradientUnits="userSpaceOnUse">
      <stop stop-color="#4B4B55"/>
      <stop offset="1" stop-color="#1C1C21"/>
    </linearGradient>
    <filter id="shadow" x="40" y="48" width="432" height="432" filterUnits="userSpaceOnUse">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
  </defs>
  <rect x="24" y="24" width="464" height="464" rx="108" fill="#050506"/>
  <rect x="28" y="28" width="456" height="456" rx="104" fill="url(#bg)"/>
  <rect x="28.75" y="28.75" width="454.5" height="454.5" rx="103.25" stroke="white" stroke-opacity="0.14" stroke-width="1.5"/>
  <rect x="88" y="92" width="336" height="328" rx="52" fill="black" fill-opacity="0.55" filter="url(#shadow)"/>
  <rect x="96" y="100" width="320" height="312" rx="46" fill="url(#sky)" stroke="url(#frame)" stroke-width="10"/>
  <circle cx="187" cy="193" r="31" fill="#F7F7FA"/>
  <path d="M121 366L221 258C233.5 244.7 253.8 244.2 267 256.9L313 300L351 260C363.8 246.9 384.1 246.4 397.5 258.9L421 280.8V366C421 380.4 409.4 392 395 392H147C132.6 392 121 380.4 121 366Z" fill="#F7F7FA"/>
  <path d="M121 366L221 258C233.5 244.7 253.8 244.2 267 256.9L313 300L351 260C363.8 246.9 384.1 246.4 397.5 258.9L421 280.8V366C421 380.4 409.4 392 395 392H147C132.6 392 121 380.4 121 366Z" fill="url(#frame)" fill-opacity="0.15"/>
  <rect x="96" y="100" width="320" height="312" rx="46" stroke="white" stroke-opacity="0.35" stroke-width="2"/>
</svg>
`;

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;

  for (const png of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(png.size >= 256 ? 0 : png.size, 0);
    entry.writeUInt8(png.size >= 256 ? 0 : png.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.buffer.length;
    entries.push(entry);
  }

  return Buffer.concat([
    header,
    ...entries,
    ...pngs.map((png) => png.buffer),
  ]);
}

async function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];

  for (const size of sizes) {
    const buffer = await sharp(Buffer.from(svg))
      .resize(size, size, { fit: 'contain' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    pngs.push({ size, buffer });
  }

  await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(
    path.join(ASSETS_DIR, 'icon.png')
  );
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), buildIco(pngs));

  console.log('Wrote assets/icon.png and assets/icon.ico');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
