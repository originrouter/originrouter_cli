function parseIdentifier(value) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function parseSemver(value) {
  const match = String(value || "").trim().match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split(".").map(parseIdentifier)
      : [],
  };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aValue = a.prerelease[index];
    const bValue = b.prerelease[index];
    if (aValue === undefined) return -1;
    if (bValue === undefined) return 1;
    if (aValue === bValue) continue;
    if (typeof aValue === "number" && typeof bValue === "string") return -1;
    if (typeof aValue === "string" && typeof bValue === "number") return 1;
    return aValue < bValue ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  return compareSemver(candidate, current) === 1;
}
