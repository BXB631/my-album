// photo-stream.js 的窗口/分块几何单测
//
// 只测纯函数：在 Node 里用一个假 window 载入浏览器脚本，然后把
// 可视区窗口、块的累积高度、数据分块对齐这几件事全部验证一遍。
//
//   node tools/test-stream-geometry.js

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'public', 'photo-stream.js'),
  'utf8'
);

const sandbox = {
  window: {},
  document: { createElement: () => ({ style: {}, dataset: {} }) },
  console,
};

vm.createContext(sandbox);
new vm.Script(SOURCE, { filename: 'photo-stream.js' }).runInContext(sandbox);

const geometry = sandbox.window.createPhotoStream?.geometry;

if (!geometry) {
  console.error('photo-stream.js 没有暴露 geometry');
  process.exit(1);
}

const failures = [];

function check(condition, message, detail) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    return;
  }

  failures.push(message);
  console.log(`  ✗ ${message}${detail ? ` — ${detail}` : ''}`);
}

function near(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) < epsilon;
}

console.log('photo-stream 几何单测');

console.log('\n[1] 列数与格子尺寸（要和 CSS 的 auto-fill minmax 对齐）');
{
  const wide = geometry.computeMetrics(1200, 1400);
  check(wide.columns === 7, '1200px 宽 → 7 列', `columns=${wide.columns}`);
  check(
    near(wide.cell, (1200 - 8 * 6) / 7),
    '格子宽度按 gap 精确分配',
    `cell=${wide.cell}`
  );
  check(
    near(wide.rowHeight, wide.cell + 8),
    '行高 = 格子宽 + gap',
    `rowHeight=${wide.rowHeight}`
  );

  const narrow = geometry.computeMetrics(600, 500);
  check(narrow.columns === 5, '窄屏（<720px）换用 104px 最小格子 → 5 列', `columns=${narrow.columns}`);

  const single = geometry.computeMetrics(80, 400);
  check(single.columns === 1, '极窄容器至少 1 列', `columns=${single.columns}`);
}

console.log('\n[2] 扫描期分块：必须刚好铺满 total');
{
  const metrics = geometry.computeMetrics(1200, 1400);
  const blocks = geometry.buildBlocks({
    grouped: false,
    days: [],
    total: 100,
    columns: metrics.columns,
    rowHeight: metrics.rowHeight,
  });

  const covered = blocks.reduce((sum, block) => sum + block.itemCount, 0);
  check(covered === 100, '所有块覆盖的条目数等于 total', `covered=${covered}`);
  check(
    blocks.every(
      (block, index) =>
        block.itemStart ===
        (index === 0 ? 0 : blocks[index - 1].itemStart + blocks[index - 1].itemCount)
    ),
    '块之间首尾相接，没有空洞'
  );
  const perBlock = geometry.constants.SCAN_ROWS_PER_BLOCK * metrics.columns;
  check(
    blocks[0].itemCount === perBlock,
    `每块 ${perBlock} 个（${geometry.constants.SCAN_ROWS_PER_BLOCK} 行）`,
    `itemCount=${blocks[0].itemCount}`
  );
  check(
    blocks.every((block) =>
      near(
        block.height,
        Math.ceil(block.itemCount / metrics.columns) * metrics.rowHeight
      )
    ),
    '块高度 = 行数 × 行高'
  );

  const empty = geometry.buildBlocks({
    grouped: false,
    days: [],
    total: 0,
    columns: 7,
    rowHeight: 100,
  });
  check(empty.length === 0, 'total=0 时不产生块');
}

console.log('\n[3] 完成后的按天分块：表头 + 该天的行');
{
  const days = [
    { key: '2026-07-05', count: 10, itemStart: 0, city: '杭州' },
    { key: '2026-07-06', count: 3, itemStart: 10, city: null },
    { key: '2026-07-07', count: 21, itemStart: 13, city: '上海' },
  ];
  const blocks = geometry.buildBlocks({
    grouped: true,
    days,
    total: 34,
    columns: 7,
    rowHeight: 100,
  });

  check(blocks.length === 3, '一天一个块', `blocks=${blocks.length}`);
  check(
    blocks.every((block, index) => block.itemStart === days[index].itemStart),
    'itemStart 原样带过来，可以直接换算成 offset'
  );
  check(
    near(blocks[0].height, geometry.constants.DAY_HEADER_HEIGHT + 2 * 100 - geometry.constants.GAP + geometry.constants.DAY_BLOCK_GAP),
    '块高度 = 表头 + 行数×行高 − 行间距 + 天间距',
    `height=${blocks[0].height}`
  );
  check(
    blocks.reduce((sum, block) => sum + block.itemCount, 0) === 34,
    '每天条目数加起来等于总数'
  );
}

console.log('\n[4] 累积高度：单调递增且末项等于总高');
{
  const blocks = geometry.buildBlocks({
    grouped: true,
    days: [
      { key: 'a', count: 10, itemStart: 0 },
      { key: 'b', count: 0, itemStart: 10 },
      { key: 'c', count: 5, itemStart: 10 },
    ],
    total: 15,
    columns: 4,
    rowHeight: 90,
  });
  const tops = geometry.blockTops(blocks);

  check(tops.length === blocks.length + 1, 'tops 长度 = 块数 + 1');
  check(
    tops.every((top, index) => index === 0 || top >= tops[index - 1]),
    '单调不减'
  );
  check(
    near(tops[tops.length - 1], blocks.reduce((sum, block) => sum + block.height, 0)),
    '最后一项是内容总高'
  );
}

console.log('\n[5] 可视窗口：只能包含真正相交的块（含随机对拍）');
{
  const random = (seed) => {
    let value = seed;
    return () => {
      value = (value * 1103515245 + 12345) % 2147483648;
      return value / 2147483648;
    };
  };
  const next = random(20261022);

  for (let round = 0; round < 200; round += 1) {
    const blocks = [];
    let total = 0;
    const count = 1 + Math.floor(next() * 30);

    for (let index = 0; index < count; index += 1) {
      const height = 40 + Math.floor(next() * 400);
      blocks.push({ kind: 'scan', itemStart: total, itemCount: 10, height });
      total += 10;
    }

    const tops = geometry.blockTops(blocks);
    const contentHeight = tops[blocks.length];
    const from = next() * contentHeight - 200;
    const to = from + next() * 1500;

    const result = geometry.findWindow(tops, blocks, from, to);
    const expected = [];

    for (let index = 0; index < blocks.length; index += 1) {
      if (tops[index] < to && tops[index + 1] > from) {
        expected.push(index);
      }
    }

    // 窗口完全在内容之外时，约定是"贴最近的块"（避免整屏空白）
    if (!expected.length) {
      expected.push(from < tops[0] ? 0 : blocks.length - 1);
    }

    const actual = [];
    for (let index = result.start; index < result.end; index += 1) {
      actual.push(index);
    }

    const same =
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]);

    if (!same) {
      failures.push(`窗口计算与暴力对拍不一致（第 ${round} 轮）`);
      console.log(
        `  ✗ 第 ${round} 轮不一致：from=${from.toFixed(1)} to=${to.toFixed(1)} 期望=[${expected}] 实际=[${actual}]`
      );
      break;
    }
  }

  if (!failures.length) {
    console.log('  ✓ 200 轮随机对拍：窗口集合与暴力计算完全一致');
  }

  const blocks = geometry.buildBlocks({
    grouped: false,
    days: [],
    total: 20,
    columns: 4,
    rowHeight: 100,
  });
  const tops = geometry.blockTops(blocks);

  check(
    geometry.findWindow(tops, blocks, -500, 1).start === 0,
    '滚到最顶部时从第 0 块开始'
  );
  check(
    geometry.findWindow(tops, blocks, 1e9, 1e9 + 100).end === blocks.length,
    '滚到最底部时能覆盖到最后一块'
  );

  const empty = geometry.findWindow([0], [], 0, 100);
  check(empty.start === 0 && empty.end === 0, '没有块时窗口为空');
}

console.log('\n[6] 数据分块对齐：滚动时不会反复请求同一段');
{
  check(
    JSON.stringify(geometry.chunkRange(0, 100, 64)) === JSON.stringify({ first: 0, last: 1 }),
    '[0,100) / 64 → 块 0..1'
  );
  check(
    JSON.stringify(geometry.chunkRange(130, 200, 64)) === JSON.stringify({ first: 2, last: 3 }),
    '[130,200) / 64 → 块 2..3'
  );
  check(
    JSON.stringify(geometry.chunkRange(64, 65, 64)) === JSON.stringify({ first: 1, last: 1 }),
    '区间刚好压在一个块上时只取该块'
  );
  check(
    JSON.stringify(geometry.chunkRange(5, 5, 64)) === JSON.stringify({ first: 0, last: 0 }),
    '空区间也至少取一个块'
  );
}

console.log('\n[7] 扫描期一律用固定占位块（不做按日期分组）');
{
  const metrics = geometry.computeMetrics(1200, 1400);
  const columns = metrics.columns;
  const perBlock = geometry.constants.SCAN_ROWS_PER_BLOCK * columns;

  // 扫描期服务端不给 days（partialDays=false），前端就用这条最短路径
  const blocks = geometry.buildBlocks({
    days: [],
    total: 110,
    columns,
    rowHeight: metrics.rowHeight,
  });

  check(
    blocks.length === Math.ceil(110 / perBlock),
    `每块 ${perBlock} 个（6 行），块数 = ceil(total / 每块)`,
    `blocks=${blocks.length}`
  );
  check(
    blocks.every((block) => block.kind === 'scan'),
    '扫描期全部是没有表头的占位块（没有日期分组）',
    blocks.map((block) => block.kind).join(',')
  );
  check(
    blocks.every(
      (block, index) =>
        block.itemStart === index * perBlock && block.itemCount <= perBlock
    ),
    '每个块的 itemStart 都落在固定格子上（扫描推进时块不会左右移动）',
    blocks.slice(0, 3).map((block) => `${block.itemStart}+${block.itemCount}`).join(' ')
  );
  check(
    blocks.reduce((sum, block) => sum + block.itemCount, 0) === 110,
    '所有块加起来刚好覆盖 total'
  );
  check(
    blocks.every((block) => near(block.height, block.rows * metrics.rowHeight)),
    '块高度 = 行数 × 行高'
  );

  const tops = geometry.blockTops(blocks);
  check(
    near(
      tops[tops.length - 1],
      blocks.reduce((sum, block) => sum + block.height, 0)
    ),
    '撑高用的总高度一致'
  );

  // 完成后（有 days）才切成"一天一块"
  const dayBlocks = geometry.buildBlocks({
    days: [
      { key: '2026-07-05', count: 10, itemStart: 0, city: '杭州' },
      { key: '2026-07-06', count: 100, itemStart: 10, city: null },
    ],
    total: 110,
    columns,
    rowHeight: metrics.rowHeight,
  });
  check(
    dayBlocks.length === 2 && dayBlocks.every((block) => block.kind === 'day'),
    '扫描完成后才是一天一个日期块',
    dayBlocks.map((block) => block.kind).join(',')
  );
}

console.log('\n[8] 扫描推进时占位块必须稳定：越扫越卡就是这里坏了');
{
  // 模拟真实的"边发现边铺格子"：total 一格一格变大，块表每轮重建。
  // 要求：已经铺好的块 itemStart/itemCount 一动不动，只有最后一块在长大，
  // 而且没有任何块会缩水/消失（否则前端每轮都要重建 DOM、重新解码缩略图）。
  const metrics = geometry.computeMetrics(1200, 1400);
  const columns = metrics.columns;
  const perBlock = geometry.constants.SCAN_ROWS_PER_BLOCK * columns;
  const finalTotal = perBlock * 4 + 13;

  let shrunk = 0;
  let vanished = 0;
  let retyped = 0;
  let previous = null;

  for (let total = 1; total <= finalTotal; total += 1) {
    const blocks = geometry.buildBlocks({
      days: [],
      total,
      columns,
      rowHeight: metrics.rowHeight,
    });

    if (previous) {
      const before = new Map(previous.map((block) => [block.itemStart, block]));
      const after = new Map(blocks.map((block) => [block.itemStart, block]));

      for (const [start, block] of after) {
        const old = before.get(start);

        if (!old) {
          continue;
        }

        if (block.itemCount < old.itemCount) {
          shrunk += 1;
        }

        if (block.kind !== old.kind) {
          retyped += 1;
        }
      }

      for (const start of before.keys()) {
        if (!after.has(start)) {
          vanished += 1;
        }
      }
    }

    previous = blocks;
  }

  check(shrunk === 0, '已铺好的占位块从不缩水', `缩水 ${shrunk} 次`);
  check(vanished === 0, '已铺好的占位块从不错位/消失', `消失 ${vanished} 次`);
  check(retyped === 0, '扫描期块类型不会来回变（一直是占位块）', `${retyped} 次`);
  console.log(
    `  · 量化：${finalTotal} 次推进 → 缩水 ${shrunk}、消失 ${vanished}、类型变化 ${retyped}`
  );
}

console.log('');

if (failures.length) {
  console.error(`几何单测失败 ${failures.length} 项`);
  process.exitCode = 1;
} else {
  console.log('几何单测全部通过 ✓');
}