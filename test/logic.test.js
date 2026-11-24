import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as L from "../mods/skills-hub/logic.js";

const sh = (home, script, args = []) => execFileSync("sh", ["-c", script, "sh", ...args], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "shub-"));
  mkdirSync(join(home, ".claude/skills/alpha"), { recursive: true });
  writeFileSync(join(home, ".claude/skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: \"Does: alpha things\"\nversion: 1.2.0\ncategory: review\n---\n\nbody\n");
  mkdirSync(join(home, ".claude/skills/local/refs"), { recursive: true });
  writeFileSync(join(home, ".claude/skills/local/SKILL.md"), "---\nname: local\ndescription: mine\n---\nx\n");
  writeFileSync(join(home, ".claude/skills/local/refs/a.md"), "ref");
  mkdirSync(join(home, ".codex/skills/alpha"), { recursive: true });
  writeFileSync(join(home, ".codex/skills/alpha/SKILL.md"), "---\nname: alpha\nversion: 1.0.0\ncategory: review\n---\n");
  mkdirSync(join(home, ".cursor"));
  return home;
}

test("listUrl picks sort by tab and query", () => {
  assert.match(L.listUrl({ tab: "trending" }), /sort=trending/);
  assert.match(L.listUrl({ tab: "top" }), /sort=highest_rated/);
  const u = L.listUrl({ tab: "top", query: " pdf tools " });
  assert.match(u, /q=pdf\+tools/);
  assert.match(u, /sort=relevance/);
});

test("skillUrl carries utm", () => {
  assert.equal(L.skillUrl("code-review"), "https://skills-hub.ai/skills/code-review?utm_source=herdr&utm_medium=mod");
});

test("buildSkillMarkdown matches CLI frontmatter", () => {
  const md = L.buildSkillMarkdown({ name: "x", description: "a: b", latestVersion: "1.0.0", category: { slug: "review" }, instructions: "do it" });
  assert.equal(md, '---\nname: x\ndescription: "a: b"\nversion: 1.0.0\ncategory: review\n---\n\ndo it\n');
});

test("compareVersions", () => {
  assert.equal(L.compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(L.compareVersions("2.0", "2.0.0"), 0);
  assert.equal(L.compareVersions("", "0.0.1"), -1);
});

test("isValidSlug", () => {
  assert.ok(L.isValidSlug("code-review"));
  assert.ok(!L.isValidSlug("../etc"));
  assert.ok(!L.isValidSlug("a--b"));
});

test("scan script finds tools and skills", () => {
  const home = fakeHome();
  const scan = L.parseScan(sh(home, L.scanScript()));
  assert.deepEqual(scan.tools, ["claude-code", "codex", "cursor"]);
  const alpha = scan.entries.find((e) => e.tool === "claude-code" && e.slug === "alpha");
  assert.deepEqual(alpha, { tool: "claude-code", slug: "alpha", version: "1.2.0", category: "review", description: "Does: alpha things" });
  assert.equal(scan.entries.length, 3);
});

test("skillState", () => {
  const home = fakeHome();
  const installed = L.groupInstalled(L.parseScan(sh(home, L.scanScript())));
  assert.equal(L.skillState("alpha", "1.2.0", installed), "update");
  assert.equal(L.skillState("nope", "1.0.0", installed), "install");
  assert.equal(L.skillState("local", null, installed), "partial");
});

test("sync fills missing tools and upgrades old copies", () => {
  const home = fakeHome();
  const scan = L.parseScan(sh(home, L.scanScript()));
  const plan = L.syncPlan(scan);
  assert.deepEqual(plan, [
    { slug: "alpha", from: ".claude", to: ".codex" },
    { slug: "alpha", from: ".claude", to: ".cursor" },
    { slug: "local", from: ".claude", to: ".codex" },
    { slug: "local", from: ".claude", to: ".cursor" },
  ]);
  sh(home, L.SYNC_SCRIPT, L.syncArgs(plan));
  assert.match(readFileSync(join(home, ".codex/skills/alpha/SKILL.md"), "utf8"), /1\.2\.0/);
  assert.ok(existsSync(join(home, ".cursor/skills/local/refs/a.md")));
  assert.deepEqual(L.syncPlan(L.parseScan(sh(home, L.scanScript()))), []);
});

test("install writes SKILL.md into each tool", () => {
  const home = fakeHome();
  const skill = { slug: "beta", name: "beta", description: "b", latestVersion: "0.1.0", category: { slug: "x" }, instructions: "it's $HOME `x`" };
  const out = sh(home, L.INSTALL_SCRIPT, L.installArgs(skill, ["claude-code", "cursor"]));
  assert.equal(out, ".claude\n.cursor\n");
  assert.equal(readFileSync(join(home, ".cursor/skills/beta/SKILL.md"), "utf8"), L.buildSkillMarkdown(skill));
  assert.throws(() => L.installArgs({ ...skill, slug: "../x" }, ["codex"]));
});

test("formatting", () => {
  assert.equal(L.formatCount(1167), "1.2k");
  assert.equal(L.formatRating(null, 0), "no ratings");
  assert.equal(L.formatRating(4.5, 3), "★ 4.5 (3)");
  assert.equal(L.oneLine("a\n b", 10), "a b");
  assert.deepEqual(L.openCommand("linux", "u"), ["xdg-open", ["u"]]);
});
