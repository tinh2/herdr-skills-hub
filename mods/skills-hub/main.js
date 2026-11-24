import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, notify, checking, spaces, focused, home, readTextFile, window as appWindow } from "herdr";
import * as L from "./logic.js";

const TABS = [["trending", "Trending"], ["top", "Top rated"], ["installed", "Installed"]];
const STATE_LABEL = { install: "Install", update: "Update", partial: "Install", installed: "Installed" };

export default class SkillsHub extends View {
  init(_props, cx) {
    this.tab = "trending";
    this.query = "";
    this.results = {};
    this.loading = false;
    this.error = "";
    this.scan = { tools: [], entries: [] };
    this.installed = [];
    this.latest = {};
    this.busy = new Set();
    this.syncing = false;
    this.machine = this.currentMachine();
    this.input = InputState.new({ placeholder: "Search skills-hub.ai" });
    this.input.on("change", (_e, cx) => this.debounce(cx));
    this.input.on("submit", (_e, cx) => this.search(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.total = null;
    this.user = null;
    this.signing = false;
    if (checking()) return;
    this.rescan(cx);
    this.load(cx);
    this.loadTotal(cx);
    this.loadUser(cx);
  }

  loadTotal(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await fetch(`${L.API}/skills/count`);
        if (r.ok) this.total = (await r.json()).count ?? null;
      } catch {}
      cx.notify();
    });
  }

  async token() {
    try {
      const c = JSON.parse((await readTextFile(`${home()}/.skills-hub/config.json`)) ?? "{}");
      return c.accessToken || c.apiKey || null;
    } catch { return null; }
  }

  loadUser(cx) {
    cx.spawn(async (cx) => {
      const tok = await this.token();
      let user = null;
      if (tok) {
        try {
          const r = await fetch(`${L.API}/users/me`, { headers: { Authorization: `Bearer ${tok}` } });
          if (r.ok) user = await r.json();
        } catch {}
      }
      this.user = user;
      cx.notify();
    });
  }

  signIn(cx) {
    if (this.signing) return;
    this.signing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("npx", ["-y", "@skills-hub-ai/cli", "login"], { timeout: 300_000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      this.signing = false;
      if (r.code !== 0) notify({ title: "skills-hub", body: (r.stderr || r.stdout || "Sign in didn't finish.").trim().split("\n").pop(), level: "error", timeout: 6000 });
      this.loadUser(cx);
    });
  }

  signOut(cx) {
    cx.spawn(async (cx) => {
      await exec("npx", ["-y", "@skills-hub-ai/cli", "logout"], { timeout: 60_000 }).catch(() => null);
      this.loadUser(cx);
    });
  }

  currentMachine() {
    const id = focused()?.space;
    return spaces().find((s) => s.id === id)?.machine ?? null;
  }

  debounce(cx) {
    this.typed = (this.typed || 0) + 1;
    const n = this.typed;
    cx.timer.after(350, (cx) => { if (n === this.typed) this.search(cx); });
  }

  search(cx) {
    const q = this.input.value().trim();
    if (q === this.query) return;
    this.query = q;
    if (q && this.tab === "installed") this.tab = "trending";
    this.load(cx);
  }

  key() {
    return this.query ? `q:${this.query}` : this.tab;
  }

  load(cx) {
    if (this.tab === "installed" && !this.query) return this.loadLatest(cx);
    const key = this.key();
    const url = L.listUrl({ tab: this.tab, query: this.query });
    this.loading = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`skills-hub.ai answered ${r.status}`);
        const body = await r.json();
        this.results[key] = body.data ?? [];
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  loadLatest(cx) {
    const slugs = this.installed.filter((g) => g.hub && !(g.slug in this.latest)).map((g) => g.slug);
    if (!slugs.length) return;
    cx.spawn(async (cx) => {
      for (let i = 0; i < slugs.length; i += 6) {
        await Promise.all(slugs.slice(i, i + 6).map(async (slug) => {
          try {
            const r = await fetch(`${L.API}/skills/${encodeURIComponent(slug)}`);
            this.latest[slug] = r.ok ? (await r.json()).latestVersion ?? null : null;
          } catch {
            this.latest[slug] = null;
          }
        }));
        cx.notify();
      }
    });
  }

  rescan(cx) {
    this.machine = this.currentMachine();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", L.scanScript()], { on: this.machine });
      this.scan = L.parseScan(r.stdout);
      this.installed = L.groupInstalled(this.scan);
      if (this.tab === "installed") this.loadLatest(cx);
      cx.notify();
    });
  }

  install(slug, cx) {
    if (this.busy.has(slug)) return;
    const tools = this.scan.tools;
    if (!tools.length) {
      notify({ title: "skills-hub", body: "No AI coding tools found on this machine.", level: "warning", timeout: 5000 });
      return;
    }
    this.busy.add(slug);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await fetch(`${L.API}/skills/${encodeURIComponent(slug)}`);
        if (!r.ok) throw new Error(`skills-hub.ai answered ${r.status}`);
        const skill = await r.json();
        const out = await exec("sh", ["-c", L.INSTALL_SCRIPT, "sh", ...L.installArgs(skill, tools)], { on: this.machine });
        if (out.code !== 0) throw new Error(out.stderr.trim() || "install failed");
        this.latest[slug] = skill.latestVersion;
        fetch(`${L.API}/skills/${encodeURIComponent(slug)}/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: skill.latestVersion, platform: L.toolById(tools[0]).platform }),
        }).catch(() => {});
        const names = tools.map((t) => L.toolById(t).label).join(", ");
        notify({ title: `Installed ${skill.name}`, body: `For ${names}`, level: "success", timeout: 4000 });
      } catch (e) {
        notify({ title: `Couldn't install ${slug}`, body: String(e?.message ?? e), level: "error", timeout: 6000 });
      }
      this.busy.delete(slug);
      this.rescan(cx);
    });
  }

  sync(cx) {
    if (this.syncing) return;
    const plan = L.syncPlan(this.scan);
    if (!plan.length) {
      notify({ title: "Skills in sync", body: "Every tool already has every skill.", timeout: 3000 });
      return;
    }
    this.syncing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", L.SYNC_SCRIPT, "sh", ...L.syncArgs(plan)], { on: this.machine, timeout: 120000 });
      const done = r.stdout.split("\n").filter(Boolean).length;
      notify({
        title: r.code === 0 ? "Skills synced" : "Sync finished with errors",
        body: r.code === 0 ? `${done} copies across ${this.scan.tools.length} tools` : r.stderr.trim(),
        level: r.code === 0 ? "success" : "error",
        timeout: 5000,
      });
      this.syncing = false;
      this.rescan(cx);
    });
  }

  open(url) {
    const [cmd, args] = L.openCommand(appWindow()?.platform, url);
    exec(cmd, args);
  }

  setTab(id, cx) {
    this.tab = id;
    if (this.query) {
      this.query = "";
      this.input.set_value("");
    }
    if (id === "installed") this.rescan(cx);
    if (!this.results[this.key()] || id === "installed") this.load(cx);
    cx.notify();
  }

  button(id, label, t, opts, onClick) {
    const { primary, disabled } = opts;
    return div().id(id).flex_none().px(10).h(24).flex().items_center().rounded(6).text_size(11.5).font_medium()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(disabled ? t.dim : t.foreground))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(label);
  }

  card(skill, t) {
    const state = L.skillState(skill.slug, skill.latestVersion, this.installed);
    const busy = this.busy.has(skill.slug);
    const label = busy ? "Installing…" : STATE_LABEL[state];
    const tip = state === "partial" ? "Installed for some tools; click to add the rest" : state === "update" ? `Update to ${skill.latestVersion}` : null;
    return h_flex().id(`card-${skill.slug}`).flex_none().mx(8).px(10).py(8).gap(10).rounded(8).items_start()
      .hover((s) => s.bg(t.hover))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().id(`title-${skill.slug}`).truncate().text_size(13).font_semibold().text_color(t.foreground)
          .cursor_pointer().hover((s) => s.text_color(t.accent).underline())
          .tooltip(`Open ${skill.name} on skills-hub.ai`)
          .on_click(() => this.open(L.skillUrl(skill.slug)))
          .child(skill.name))
        .child(div().text_size(11.5).text_color(t.muted).child(L.oneLine(skill.description)))
        .child(h_flex().gap(10).text_size(10.5).text_color(t.dim)
          .child(div().child(L.formatRating(skill.avgRating, skill.reviewCount)))
          .child(div().child(`${L.formatCount(skill.installCount)} installs`))
          .when(Boolean(skill.author?.username), (el) => el.child(div().truncate().child(`@${skill.author.username}`)))))
      .child(div().flex_none().pt(2)
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .child(this.button(`install-${skill.slug}`, label, t, { primary: state === "install" || state === "update", disabled: busy || state === "installed" }, (cx) => this.install(skill.slug, cx))));
  }

  installedRow(g, t) {
    const latest = this.latest[g.slug];
    const outdated = latest && Object.values(g.tools).some((v) => L.compareVersions(v, latest) < 0);
    const busy = this.busy.has(g.slug);
    const have = Object.keys(g.tools).length;
    const toolNames = Object.keys(g.tools).map((id) => L.toolById(id)?.label ?? id).join(", ");
    return h_flex().id(`inst-${g.slug}`).flex_none().mx(8).px(10).py(6).gap(10).rounded(8).items_center()
      .hover((s) => s.bg(t.hover))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().id(`ititle-${g.slug}`).truncate().text_size(12.5).font_medium().text_color(t.foreground)
            .when(g.hub, (el) => el.cursor_pointer().hover((s) => s.text_color(t.accent).underline()).on_click(() => this.open(L.skillUrl(g.slug))))
            .child(g.slug))
          .when(Boolean(g.version), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`v${g.version}`))))
        .when(Boolean(g.description), (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(L.oneLine(g.description, 100)))))
      .child(div().id(`tools-${g.slug}`).flex_none().text_size(10.5).tooltip(toolNames)
        .text_color(g.missing.length ? t.blocked : t.dim)
        .child(`${have}/${this.scan.tools.length} tools`))
      .when(Boolean(outdated), (el) => el.child(this.button(`upd-${g.slug}`, busy ? "Updating…" : `Update ${latest}`, t, { primary: true, disabled: busy }, (cx) => this.install(g.slug, cx))));
  }

  render() {
    const t = theme();
    const showInstalled = this.tab === "installed" && !this.query;
    const list = showInstalled ? null : this.results[this.key()];
    const toolLabels = this.scan.tools.map((id) => L.toolById(id).label).join(", ");
    const pending = L.syncPlan(this.scan).length;

    const header = h_flex().flex_none().px(16).pt(12).pb(6).gap(8).items_center()
      .child(div().id("brand").text_size(14).font_bold().text_color(t.foreground).cursor_pointer()
        .hover((s) => s.text_color(t.accent)).tooltip("Open skills-hub.ai")
        .on_click(() => this.open(L.siteUrl())).child("skills-hub.ai"))
      .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child("the skillshare for Herdr"))
      .when(Boolean(this.user), (el) => el.child(div().id("me").text_size(11.5).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).tooltip("Signed in. Click to sign out.")
        .on_click((_e, cx) => this.signOut(cx)).child(`@${this.user.username}`)))
      .when(!this.user, (el) => el.child(this.button("signin", this.signing ? "Finish in browser…" : "Sign in", t, { disabled: this.signing }, (cx) => this.signIn(cx))));

    const search = div().id("search").flex_none().mx(16).my(4).h(30).px(10).flex().items_center().rounded(8)
      .border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground));

    const tabs = h_flex().flex_none().px(16).pt(4).pb(6).gap(4).items_center().children(TABS.map(([id, label]) => {
      const on = !this.query && this.tab === id;
      const text = id === "installed" && this.installed.length ? `${label} · ${this.installed.length}` : label;
      return div().id(`tab-${id}`).px(10).h(24).flex().items_center().rounded(12).text_size(11.5).cursor_pointer()
        .when(on, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
        .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.setTab(id, cx)).child(text);
    })).when(Boolean(this.query), (el) => el.child(div().pl(6).text_size(11).text_color(t.dim).child(`Results for “${this.query}”`)));

    const status = h_flex().flex_none().px(16).pb(6).gap(6).text_size(10.5).text_color(t.dim)
      .child(div().flex_1().truncate().child(this.scan.tools.length
        ? `Installs to ${toolLabels}${this.machine ? ` on ${this.machine}` : ""}`
        : "No AI coding tools found"));

    let body;
    if (showInstalled) {
      body = v_flex().id("installed-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar()
        .child(h_flex().flex_none().mx(16).mb(6).gap(8).items_center()
          .child(div().flex_1().text_size(11.5).text_color(t.muted)
            .child(pending ? `${pending} copies missing or older across tools` : "Every tool has every skill"))
          .child(this.button("sync", this.syncing ? "Syncing…" : "Sync to all tools", t, { primary: pending > 0, disabled: this.syncing || !pending }, (cx) => this.sync(cx))))
        .when(!this.installed.length, (el) => el.child(div().px(16).text_size(12).text_color(t.dim).child("No skills installed yet.")))
        .children(this.installed.map((g) => this.installedRow(g, t)));
    } else {
      body = v_flex().id("catalog-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().px(16).text_size(12).text_color(t.blocked).child(this.error)))
        .when(!list && !this.error, (el) => el.child(div().px(16).text_size(12).text_color(t.dim).child("Loading skills…")))
        .when(Boolean(list) && !list.length, (el) => el.child(div().px(16).text_size(12).text_color(t.dim).child("No skills match.")))
        .children((list ?? []).map((s) => this.card(s, t)));
    }

    const footer = h_flex().id("footer").flex_none().px(16).h(30).items_center().border_t_1().border_color(t.border)
      .text_size(11).text_color(t.dim)
      .child(div().flex_1().child(this.loading ? "Loading…" : this.total ? `${this.total.toLocaleString("en-US")} skills on skills-hub.ai` : "skills-hub.ai"))
      .child(div().id("publish").cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click(() => this.open(L.siteUrl("/publish"))).child("Publish a skill ↗"));

    return v_flex().id("skills-hub").size_full().bg(t.surface).text_color(t.foreground)
      .child(header).child(search).child(tabs).child(status).child(body).child(footer);
  }
}
