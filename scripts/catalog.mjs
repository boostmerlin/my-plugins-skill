export function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a non-empty array of strings`);
  }
}

export function validateExclusiveGroups(entries, label) {
  const groups = new Map();
  for (const [index, entry] of entries.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (entry.exclusiveGroup !== undefined) {
      if (typeof entry.exclusiveGroup !== "string" || !entry.exclusiveGroup.trim()) {
        throw new Error(`${itemLabel}.exclusiveGroup must be a non-empty string`);
      }
      entry.exclusiveGroup = entry.exclusiveGroup.trim();
    }
    if (entry.defaultInExclusiveGroup !== undefined && (!entry.exclusiveGroup || typeof entry.defaultInExclusiveGroup !== "boolean")) {
      throw new Error(`${itemLabel}.defaultInExclusiveGroup requires exclusiveGroup and a boolean`);
    }
    if (!entry.exclusiveGroup) continue;
    if (!groups.has(entry.exclusiveGroup)) groups.set(entry.exclusiveGroup, []);
    groups.get(entry.exclusiveGroup).push(entry);
  }
  for (const [group, members] of groups) {
    if (members.length < 2) throw new Error(`${label} exclusive group ${group} must contain at least two members`);
    if (members.filter((entry) => entry.defaultInExclusiveGroup === true).length !== 1) {
      throw new Error(`${label} exclusive group ${group} must have exactly one defaultInExclusiveGroup entry`);
    }
  }
  return groups;
}

export function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw new Error("profiles must be an object");
  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error(`profiles.${name} must be an object`);
  }
  return validateExclusiveGroups(Object.values(profiles), "Profile");
}

export function parseChoice(value) {
  const parts = typeof value === "string" ? value.split("=").map((part) => part.trim()) : [];
  if (parts.length !== 2 || parts.some((part) => !part) || parts[0].startsWith("--")) {
    throw new Error("--choose requires <group>=<name>");
  }
  const [group, name] = parts;
  return { group, name };
}
