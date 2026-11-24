export const API = "https://api.skills-hub.ai/api/v1";
export const SITE = "https://skills-hub.ai";
export const UTM = "utm_source=herdr&utm_medium=mod";

export const TOOLS = [
  { id: "claude-code", label: "Claude Code", dir: ".claude", platform: "CLAUDE_CODE" },
  { id: "codex", label: "Codex", dir: ".codex", platform: "CODEX" },
  { id: "cursor", label: "Cursor", dir: ".cursor", platform: "CURSOR" },
  { id: "gemini", label: "Gemini", dir: ".gemini", platform: "GEMINI" },
  { id: "windsurf", label: "Windsurf", dir: ".windsurf", platform: "WINDSURF" },
  { id: "opencode", label: "OpenCode", dir: ".opencode", platform: "OPENCODE" },
  { id: "cline", label: "Cline", dir: ".cline", platform: "CLINE" },
  { id: "roo", label: "Roo Code", dir: ".roo", platform: "ROO" },
  { id: "augment", label: "Augment", dir: ".augment", platform: "AUGMENT" },
  { id: "continue", label: "Continue", dir: ".continue", platform: "CONTINUE" },
  { id: "junie", label: "Junie", dir: ".junie", platform: "JUNIE" },
];

export const toolById = (id) => TOOLS.find((t) => t.id === id);

export function skillUrl(slug) {
  return `${SITE}/skills/${encodeURIComponent(slug)}?${UTM}`;
}

export function siteUrl(path = "") {
  return `${SITE}${path}?${UTM}`;
}

export function listUrl({ tab, query, limit = 30 }) {
  const q = (query || "").trim();
  const params = new URLSearchParams({ limit: String(limit) });
  if (q) {
    params.set("q", q);
    params.set("sort", "relevance");
  } else {
    params.set("sort", tab === "top" ? "highest_rated" : "trending");
  }
  return `${API}/skills?${params}`;
}

export function isValidSlug(s) {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && !/--/.test(s) && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s);
}

export function escapeYamlValue(value) {
  if (value === null || value === undefined || value === "" || typeof value !== "string") return "";
  if (/[:\-#{}\[\]&*!|>'"%@`]/.test(value) || value.includes("\n")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function buildSkillMarkdown(skill) {
  return [
    "---",
    `name: ${escapeYamlValue(skill.name)}`,
    `description: ${escapeYamlValue(skill.description)}`,
    `version: ${escapeYamlValue(skill.latestVersion)}`,
    `category: ${escapeYamlValue(skill.category?.slug ?? "")}`,
    "---",
    "",
    skill.instructions ?? "",
    "",
  ].join("\n");
}

export function compareVersions(a, b) {
  const pa = String(a || "").split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = String(b || "").split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const AWK = `function val(s){sub(/^[a-z]+:[ \\t]*/,"",s);gsub(/^["\\047]|["\\047]$/,"",s);gsub(/\\t/," ",s);return s}
FNR==1{n=split(FILENAME,p,"/");slug=p[n-1];v="";c="";d="";if($0!="---"){print "S\\t" t "\\t" slug "\\t\\t\\t";nextfile}next}
$0=="---"||FNR>60{print "S\\t" t "\\t" slug "\\t" v "\\t" c "\\t" d;nextfile}
/^version:/{v=val($0)}
/^category:/{c=val($0)}
/^description:/{d=val($0)}`;

export function scanScript() {
  const pairs = TOOLS.map((t) => `${t.id}:${t.dir}`).join(" ");
  return `for e in ${pairs}; do id=\${e%%:*}; d="$HOME/\${e#*:}"; [ -d "$d" ] || continue; printf 'T\\t%s\\n' "$id"; set -- "$d"/skills/*/SKILL.md; [ -f "$1" ] || continue; awk -v t="$id" '${AWK.replace(/'/g, "")}' "$@" 2>/dev/null; done`;
}

export function parseScan(stdout) {
  const tools = [];
  const entries = [];
  for (const line of String(stdout || "").split("\n")) {
    const f = line.split("\t");
    if (f[0] === "T" && toolById(f[1])) tools.push(f[1]);
    else if (f[0] === "S" && f[2]) entries.push({ tool: f[1], slug: f[2], version: f[3] || "", category: f[4] || "", description: f[5] || "" });
  }
  return { tools, entries };
}

export function groupInstalled(scan) {
  const map = new Map();
  for (const e of scan.entries) {
    let g = map.get(e.slug);
    if (!g) map.set(e.slug, (g = { slug: e.slug, tools: {}, version: "", hub: false, description: "" }));
    g.tools[e.tool] = e.version;
    if (e.category) g.hub = true;
    if (!g.description && e.description) g.description = e.description;
    if (e.version && compareVersions(e.version, g.version) > 0) g.version = e.version;
  }
  return [...map.values()]
    .map((g) => ({ ...g, missing: scan.tools.filter((t) => !(t in g.tools)) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function skillState(slug, latestVersion, installed) {
  const g = installed.find((i) => i.slug === slug);
  if (!g) return "install";
  if (latestVersion && Object.values(g.tools).some((v) => compareVersions(v, latestVersion) < 0)) return "update";
  if (g.missing.length) return "partial";
  return "installed";
}

export function syncPlan(scan) {
  const order = (id) => TOOLS.findIndex((t) => t.id === id);
  const plan = [];
  for (const g of groupInstalled(scan)) {
    const from = Object.keys(g.tools).sort((a, b) => compareVersions(g.tools[b], g.tools[a]) || order(a) - order(b))[0];
    const best = g.tools[from];
    const to = scan.tools.filter((t) => t !== from && (!(t in g.tools) || compareVersions(g.tools[t], best) < 0));
    for (const t of to) plan.push({ slug: g.slug, from: toolById(from).dir, to: toolById(t).dir });
  }
  return plan;
}

export const SYNC_SCRIPT = `while [ $# -ge 3 ]; do s=$1; f=$2; t=$3; shift 3; mkdir -p "$HOME/$t/skills/$s" && cp -R "$HOME/$f/skills/$s/." "$HOME/$t/skills/$s/" && printf '%s\\n' "$s"; done`;

export function syncArgs(plan) {
  return plan.flatMap((p) => [p.slug, p.from, p.to]);
}

export const INSTALL_SCRIPT = `c=$1; s=$2; shift 2; for d in "$@"; do mkdir -p "$HOME/$d/skills/$s" && printf '%s' "$c" > "$HOME/$d/skills/$s/SKILL.md" && printf '%s\\n' "$d"; done`;

export function installArgs(skill, tools) {
  if (!isValidSlug(skill.slug)) throw new Error(`Invalid slug: ${skill.slug}`);
  return [buildSkillMarkdown(skill), skill.slug, ...tools.map((id) => toolById(id).dir)];
}

export function formatCount(n) {
  const x = Number(n) || 0;
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (x >= 1000) return `${(x / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(x);
}

export function formatRating(avg, count) {
  if (!avg || !count) return "no ratings";
  return `★ ${Number(avg).toFixed(1)} (${count})`;
}

export function oneLine(text, max = 140) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function openCommand(platform, url) {
  if (platform === "windows") return ["cmd", ["/c", "start", "", url]];
  if (platform === "linux") return ["xdg-open", [url]];
  return ["open", [url]];
}
