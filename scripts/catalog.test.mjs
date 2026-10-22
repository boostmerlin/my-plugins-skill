import assert from "node:assert/strict";
import test from "node:test";
import { assertStringArray, parseChoice, validateExclusiveGroups, validateProfiles } from "./catalog.mjs";

test("string arrays reject empty or invalid entries without rewriting valid values", () => {
  const values = ["one", " two "];
  assert.doesNotThrow(() => assertStringArray(values, "names"));
  assert.deepEqual(values, ["one", " two "]);
  for (const value of [null, {}, "one", [], [""], [" "], [null], [1]]) {
    assert.throws(() => assertStringArray(value, "names"), /names.*non-empty array/);
  }
});

test("exclusive groups normalize names while returning original entries and preserving separate groups", () => {
  const first = { exclusiveGroup: " __proto__ ", defaultInExclusiveGroup: true };
  const second = { exclusiveGroup: "__proto__" };
  const other = { exclusiveGroup: "constructor", defaultInExclusiveGroup: true };
  const last = { exclusiveGroup: "constructor", defaultInExclusiveGroup: false };
  const groups = validateExclusiveGroups([first, second, {}, other, last], "Entry");
  assert.deepEqual([...groups.keys()], ["__proto__", "constructor"]);
  assert.equal(groups.get("__proto__")[0], first);
  assert.equal(groups.get("__proto__")[1], second);
  assert.equal(first.exclusiveGroup, "__proto__");
  assert.deepEqual(groups.get("constructor"), [other, last]);
});

test("exclusive groups require valid group fields, multiple members and exactly one default", () => {
  for (const entries of [
    [{ exclusiveGroup: " " }], [{ exclusiveGroup: 1 }], [{ defaultInExclusiveGroup: false }],
    [{ exclusiveGroup: "g", defaultInExclusiveGroup: "true" }],
    [{ exclusiveGroup: "g", defaultInExclusiveGroup: true }],
    [{ exclusiveGroup: "g" }, { exclusiveGroup: "g" }],
    [{ exclusiveGroup: "g", defaultInExclusiveGroup: true }, { exclusiveGroup: "g", defaultInExclusiveGroup: true }],
  ]) {
    assert.throws(() => validateExclusiveGroups(entries, "Entry"), /exclusive/i);
  }
});

test("profile validation rejects malformed shapes and returns normalized groups", () => {
  for (const profiles of [null, [], "profiles", { a: null }, { a: [] }, { a: "profile" }]) {
    assert.throws(() => validateProfiles(profiles), /profiles.*object/);
  }
  const profiles = { core: {}, a: { exclusiveGroup: " g ", defaultInExclusiveGroup: true }, b: { exclusiveGroup: "g" } };
  const groups = validateProfiles(profiles);
  assert.equal(groups.get("g")[0], profiles.a);
  assert.equal(groups.get("g")[1], profiles.b);
  assert.equal(profiles.a.exclusiveGroup, "g");
  assert.equal(validateProfiles({}).size, 0);
});

test("choice syntax trims both fields and leaves semantic identity for catalog resolution", () => {
  assert.deepEqual(parseChoice(" writing = Alias-A "), { group: "writing", name: "Alias-A" });
  assert.deepEqual(parseChoice("__proto__=a"), { group: "__proto__", name: "a" });
  assert.deepEqual(parseChoice("constructor=b"), { group: "constructor", name: "b" });
  for (const value of [undefined, null, 1, "", "a", "=a", "a=", " a = ", "a=b=c", "--bad=a", " --bad=a "]) {
    assert.throws(() => parseChoice(value), /choose/);
  }
});
