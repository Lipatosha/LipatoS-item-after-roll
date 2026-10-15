const assert = require("node:assert/strict");
const fs = require("node:fs");
const js = fs.readFileSync("scripts/main.js", "utf8");
assert.ok(js.includes("await actor.performBulkUpdate(bulk, {"),
  "Deferred consumption must still use Foundry bulk updates");
assert.ok(js.includes("deleteOptions: { lipatosItemConsumed: true, itemMoveStackUse: true }"),
  "Deleting a depleted item must not look like manual deletion");
assert.ok(js.includes("if (rolls?.length) await commitAfterRoll"),
  "Resources must still be spent after a completed roll");
console.log("Deferred consumption depletion flags passed.");
