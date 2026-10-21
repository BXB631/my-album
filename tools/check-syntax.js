const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.pnpm-store',
  'data',
  'cache',
  'dist',
  'release',
  'test-runtime',
  'photos',
]);

const REQUIRED_FILES = [
  'package.json',
  'server.js',
  'electron/main.js',
  'public/index.html',
  'lib/media.js',
  'assets/icon.ico',
];

function walk(directory, output) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.test-')) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      walk(absolutePath, output);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      output.push(absolutePath);
    }
  }
}

function main() {
  const missing = REQUIRED_FILES.filter(
    (file) => !fs.existsSync(path.join(ROOT, file))
  );

  if (missing.length) {
    console.error(`Missing required files:\n${missing.join('\n')}`);
    process.exitCode = 1;
    return;
  }

  JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const files = [];
  for (const directory of ['electron', 'lib', 'public', 'tools']) {
    const absolutePath = path.join(ROOT, directory);

    if (fs.existsSync(absolutePath)) {
      walk(absolutePath, files);
    }
  }

  files.push(path.join(ROOT, 'server.js'));

  const failures = [];

  for (const file of files) {
    try {
      new vm.Script(fs.readFileSync(file, 'utf8'), {
        filename: path.relative(ROOT, file),
      });
    } catch (error) {
      failures.push(
        `${path.relative(ROOT, file)}\n${error.stack || error.message}`
      );
    }
  }

  if (failures.length) {
    console.error('Syntax check failed:\n');
    for (const failure of failures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Syntax OK (${files.length} JavaScript files)`);
}

main();
