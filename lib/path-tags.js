const YEAR_PATTERN = /^((?:19|20)\d{2})$/;
const COMPACT_PATTERN = /^((?:19|20)\d{2})[._-]?(0[1-9]|1[0-2])$/;
const YEAR_MONTH_CN_PATTERN =
  /^((?:19|20)\d{2})年(0?[1-9]|1[0-2])月$/;
const MONTH_PATTERN = /^(0?[1-9]|1[0-2])$/;
const MONTH_CN_PATTERN = /^(0?[1-9]|1[0-2])月$/;

function makeTag(year, month) {
  const normalizedMonth =
    Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;

  return {
    year,
    month: normalizedMonth,
    monthKey: normalizedMonth
      ? `${year}-${String(normalizedMonth).padStart(2, '0')}`
      : null,
  };
}

function parseSegments(segments, { fromEnd = false } = {}) {
  const indexes = Array.from(
    { length: segments.length },
    (_, index) => index
  );

  if (fromEnd) {
    indexes.reverse();
  }

  for (const index of indexes) {
    const segment = String(segments[index] || '').trim();

    const yearOnly = segment.match(YEAR_PATTERN);
    if (yearOnly) {
      const year = Number(yearOnly[1]);
      const next = String(segments[index + 1] || '').trim();
      const compactNext = next.match(COMPACT_PATTERN);

      if (compactNext && Number(compactNext[1]) === year) {
        return makeTag(year, Number(compactNext[2]));
      }

      const monthOnly =
        next.match(MONTH_PATTERN) || next.match(MONTH_CN_PATTERN);

      if (monthOnly) {
        return makeTag(year, Number(monthOnly[1]));
      }

      return makeTag(year, null);
    }

    const compact = segment.match(COMPACT_PATTERN);
    if (compact) {
      return makeTag(Number(compact[1]), Number(compact[2]));
    }

    const yearMonthCn = segment.match(YEAR_MONTH_CN_PATTERN);
    if (yearMonthCn) {
      return makeTag(Number(yearMonthCn[1]), Number(yearMonthCn[2]));
    }
  }

  return null;
}

function parseYearMonth(relativePath) {
  const segments = String(relativePath || '')
    .split(/[\\/]+/)
    .filter(Boolean);

  // 最后一段是文件名，不参与年份/月份识别。
  return parseSegments(segments.slice(0, -1));
}

function parseYearMonthFromAbsolute(absolutePath) {
  const segments = String(absolutePath || '')
    .split(/[\\/]+/)
    .filter(Boolean);

  // 最后一段是文件名；从最靠近文件的目录开始找，避免把上层目录里的数字误判。
  return parseSegments(segments.slice(0, -1), { fromEnd: true });
}

module.exports = {
  parseYearMonth,
  parseYearMonthFromAbsolute,
};
