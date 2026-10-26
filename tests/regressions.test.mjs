import assert from "node:assert/strict";
import test from "node:test";
import moment from "moment";
import { get, writable } from "svelte/store";
import { createApp, MarkdownView, TFile } from "obsidian";

import PeriodicNotesPlugin from "../src/main.ts";
import CalendarSetManager, { migrateLegacySettingsToCalendarSet } from "../src/calendarSetManager.ts";
import { PeriodicNotesCache } from "../src/cache.ts";
import TimelineManager from "../src/timeline/manager.ts";
import { DEFAULT_SETTINGS } from "../src/settings/index.ts";
import { deleteCalendarSet } from "../src/settings/utils.ts";
import { applyTemplateTransformations, getTemplateContents } from "../src/utils.ts";
import { getLooselyMatchedDate } from "../src/parser.ts";
import ComponentMock from "./component-mock.mjs";

globalThis.window = { moment };
Object.defineProperty(Array.prototype, "remove", { value(item) { const i = this.indexOf(item); if (i >= 0) this.splice(i, 1); } });
const date = () => moment("2026-10-26", "YYYY-MM-DD", true);
const config = (folder, format = "") => ({ enabled: true, folder, format, templatePath: "", openAtStartup: false });
const calendar = (id = "Default", folder = "daily") => ({ id, ctime: "", day: config(folder) });

function setup(sets = [calendar()]) {
  const app = createApp();
  globalThis.app = app;
  const plugin = new PeriodicNotesPlugin(app);
  plugin.settings = writable({ ...structuredClone(DEFAULT_SETTINGS), calendarSets: sets, activeCalendarSet: sets[0].id });
  plugin.calendarSetManager = new CalendarSetManager(plugin);
  return { app, plugin };
}
async function cacheFor(app, plugin) {
  const cache = new PeriodicNotesCache(app, plugin);
  await cache.load();
  return cache;
}

test("Timeline releases closed views, recreates reopened views, and cleans up once", () => {
  const { app, plugin } = setup();
  const view = new MarkdownView();
  app.workspace.leaves = [{ view }];
  const manager = new TimelineManager(plugin, {});
  const original = ComponentMock.instances.at(-1);
  const count = ComponentMock.instances.length;
  app.workspace.trigger("layout-change");
  assert.equal(ComponentMock.instances.length, count);
  app.workspace.leaves = [];
  app.workspace.trigger("layout-change");
  assert.equal(original.destroyCount, 1);
  app.workspace.leaves = [{ view }];
  app.workspace.trigger("layout-change");
  const reopened = ComponentMock.instances.at(-1);
  assert.notEqual(reopened, original);
  manager.cleanup();
  manager.cleanup();
  app.workspace.trigger("layout-change");
  assert.equal(reopened.destroyCount, 1);
  assert.equal(ComponentMock.instances.length, count + 1);
});

test("deferred Timeline initialization does not run after cleanup", () => {
  const { app, plugin } = setup();
  app.workspace.ready = false;
  const manager = new TimelineManager(plugin, {});
  manager.cleanup();
  app.workspace.readyCallbacks.forEach((cb) => cb());
  assert.equal(app.workspace.count("layout-change"), 0);
});

test("plugin reloads release all cache event listeners", async () => {
  const app = createApp();
  globalThis.app = app;
  for (let i = 0; i < 3; i++) {
    const plugin = new PeriodicNotesPlugin(app);
    plugin.savedData = { calendarSets: [calendar()], activeCalendarSet: "Default" };
    await plugin.load();
    assert.ok(plugin._children.includes(plugin.cache));
    assert.equal(app.vault.count("create"), 1);
    plugin.unload();
    assert.equal(app.vault.count("create"), 0);
    assert.equal(app.vault.count("rename"), 0);
    assert.equal(app.vault.count("delete"), 0);
    assert.equal(app.metadataCache.count("changed"), 0);
    assert.equal(app.workspace.count("periodic-notes:settings-updated"), 0);
  }
});

test("deferred cache initialization does not register after unload", async () => {
  const { app, plugin } = setup();
  app.workspace.ready = false;
  const cache = await cacheFor(app, plugin);
  cache.unload();
  app.workspace.readyCallbacks.forEach((cb) => cb());
  assert.equal(app.vault.count("create"), 0);
});

test("loading 1.0.0 preserves the vault's global date locale", async () => {
  const { plugin } = setup();
  plugin.savedData = { calendarSets: [calendar()], activeCalendarSet: "Default" };
  const before = [moment.locale(), moment.localeData().firstDayOfWeek(), moment.localeData().firstDayOfYear()];
  await plugin.load();
  assert.deepEqual([moment.locale(), moment.localeData().firstDayOfWeek(), moment.localeData().firstDayOfYear()], before);
  plugin.unload();
});

test("cache ignores date-named folders, binary files and sibling folder prefixes", async () => {
  const { app, plugin } = setup();
  await app.vault.createFolder("daily");
  await app.vault.createFolder("daily-extra");
  const cache = await cacheFor(app, plugin);
  await app.vault.createFolder("daily/2026-10-26");
  await app.vault.create("daily/2026-10-26.png", "binary");
  await app.vault.create("daily-extra/2026-10-26.md", "text");
  assert.equal(cache.getPeriodicNote("Default", "day", date()), null);
  const valid = await app.vault.create("daily/2026-10-26.md", "text");
  assert.equal(cache.getPeriodicNote("Default", "day", date()), valid);
});

test("a configured folder pointing to a file does not crash initialization", async () => {
  const { app, plugin } = setup([calendar("Default", "file.md")]);
  await app.vault.create("file.md", "text");
  await cacheFor(app, plugin);
});

test("frontmatter changes and removal invalidate cached dates", async () => {
  const { app, plugin } = setup();
  await app.vault.createFolder("daily");
  const file = await app.vault.create("daily/journal.md", "text");
  app.metadataCache.caches.set(file, { frontmatter: { day: "2026-10-26" } });
  const cache = await cacheFor(app, plugin);
  assert.equal(cache.getPeriodicNote("Default", "day", date()), file);
  app.metadataCache.trigger("changed", file, "", { frontmatter: { day: "2026-10-27" } });
  assert.equal(cache.getPeriodicNote("Default", "day", date()), null);
  assert.equal(cache.getPeriodicNote("Default", "day", date().add(1, "day")), file);
  app.metadataCache.trigger("changed", file, "", {});
  assert.equal(cache.find(file.path), null);
});

test("invalid day frontmatter does not hide valid month frontmatter", async () => {
  const set = calendar();
  set.month = config("daily");
  const { app, plugin } = setup([set]);
  await app.vault.createFolder("daily");
  const file = await app.vault.create("daily/journal.md", "text");
  const cache = await cacheFor(app, plugin);
  app.metadataCache.trigger("changed", file, "", { frontmatter: { day: "invalid", month: "2026-10" } });
  assert.equal(cache.find(file.path)?.granularity, "month");
});

test("deleting and moving notes removes stale navigation entries", async () => {
  const { app, plugin } = setup();
  await app.vault.createFolder("daily");
  const first = await app.vault.create("daily/2026-10-26.md", "text");
  const second = await app.vault.create("daily/2026-10-27.md", "text");
  const cache = await cacheFor(app, plugin);
  assert.equal(cache.findAdjacent("Default", first.path, "forwards").filePath, second.path);
  app.vault.files.delete(second.path);
  app.vault.trigger("delete", second);
  assert.ok(cache.findAdjacent("Default", first.path, "forwards") == null);
  const oldPath = first.path;
  first.path = "outside/2026-10-26.md";
  app.vault.trigger("rename", first, oldPath);
  assert.equal(cache.find(oldPath), null);
  assert.equal(cache.find(first.path), null);
});

test("folder rename removes every old descendant path", async () => {
  const { app, plugin } = setup([calendar("Default", "/")]);
  const folder = await app.vault.createFolder("old");
  const file = await app.vault.create("old/2026-10-26.md", "text");
  const cache = await cacheFor(app, plugin);
  folder.path = "new";
  file.path = "new/2026-10-26.md";
  app.vault.files.delete("old/2026-10-26.md");
  app.vault.files.set(file.path, file);
  app.vault.trigger("rename", folder, "old");
  assert.equal(cache.find("old/2026-10-26.md"), null);
  assert.equal(cache.find(file.path)?.date.format("YYYY-MM-DD"), "2026-10-26");
});

test("find prefers the active calendar set for overlapping folders", async () => {
  const { app, plugin } = setup([calendar("A"), calendar("B")]);
  await app.vault.createFolder("daily");
  const file = await app.vault.create("daily/2026-10-26.md", "text");
  const cache = await cacheFor(app, plugin);
  plugin.settings.update((s) => ({ ...s, activeCalendarSet: "B" }));
  assert.equal(cache.find(file.path).calendarSet, "B");
});

test("weekly templates preserve the caller's Moment date", () => {
  const selected = date();
  const before = selected.valueOf();
  const result = applyTemplateTransformations("week", "week", selected, "gggg-[W]ww", "{{monday:YYYY-MM-DD}} {{sunday:YYYY-MM-DD}}");
  assert.ok(result.includes("2026-10-26"));
  assert.equal(selected.valueOf(), before);
});

test("the cache leaves externally created empty notes untouched as in 1.0.0", async () => {
  const { app, plugin } = setup();
  get(plugin.settings).calendarSets[0].day.templatePath = "template.md";
  await app.vault.create("template.md", "# {{date}}");
  await app.vault.createFolder("daily");
  const cache = await cacheFor(app, plugin);
  const file = await app.vault.create("daily/2026-10-26.md", "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.getPeriodicNote("Default", "day", date()), file);
  assert.equal(file.contents, "");
  await app.vault.modify(file, "new user content");
  app.metadataCache.trigger("changed", file, "", {});
  assert.equal(file.contents, "new user content");
});

test("explicit note creation still renders the configured template", async () => {
  const { app, plugin } = setup();
  get(plugin.settings).calendarSets[0].day.templatePath = "template.md";
  await app.vault.create("template.md", "# {{date}}");
  const file = await plugin.createPeriodicNote("day", date());
  assert.equal(file.contents, "# 2026-10-26");
});

test("concurrent opens create one note and preserve pre-existing content", async () => {
  const { app, plugin } = setup();
  const files = await Promise.all(Array.from({ length: 8 }, () => plugin.createPeriodicNote("day", date())));
  assert.equal(new Set(files).size, 1);
  assert.equal(app.vault.createCalls, 1);
  files[0].contents = "preserved";
  assert.equal(await plugin.createPeriodicNote("day", date()), files[0]);
  assert.equal(files[0].contents, "preserved");
});

test("creating different dates concurrently can share a new folder", async () => {
  const { app, plugin } = setup();
  const files = await Promise.all([plugin.createPeriodicNote("day", date()), plugin.createPeriodicNote("day", date().add(1, "day"))]);
  assert.equal(new Set(files).size, 2);
  assert.equal(app.vault.createCalls, 2);
});

test("openPeriodicNote honors the requested calendar set when creating a note", async () => {
  const { app, plugin } = setup([calendar("A", "a"), calendar("B", "b")]);
  plugin.cache = await cacheFor(app, plugin);
  await plugin.openPeriodicNote("day", date(), { calendarSet: "B" });
  assert.equal(app.workspace.opened[0].path, "b/2026-10-26.md");
  assert.equal(plugin.calendarSetManager.getActiveId(), "A");
});

test("invalid dates do not create Invalid date.md", async () => {
  const { app, plugin } = setup();
  await assert.rejects(plugin.createPeriodicNote("day", moment.invalid()), /invalid date/);
  assert.equal(app.vault.createCalls, 0);
  assert.equal(getLooselyMatchedDate("2026-02-31 meeting"), null);
});

test("core daily note settings migrate without requiring legacy plugin settings", async () => {
  const { app, plugin } = setup();
  app.internalPlugins.plugins["daily-notes"] = { instance: { options: { folder: "journal", format: "YYYY/MM/DD", template: "template.md", autorun: true } } };
  await plugin.loadSettings();
  const settings = get(plugin.settings);
  assert.equal(settings.calendarSets[0].day.folder, "journal");
  assert.equal(settings.calendarSets[0].day.openAtStartup, true);
  assert.equal(settings.calendarSets[0].day.templatePath, "template.md");
});

test("partial legacy settings migrate disabled missing periods", () => {
  const migrated = migrateLegacySettingsToCalendarSet({ daily: { enabled: true, folder: "journal" } });
  assert.equal(migrated.day.folder, "journal");
  assert.equal(migrated.week.enabled, false);
  assert.equal(migrated.year.templatePath, "");
});

test("first-run defaults are isolated between plugin instances", async () => {
  const first = setup().plugin;
  const second = setup().plugin;
  await first.loadSettings();
  await second.loadSettings();
  assert.equal(get(first.settings).calendarSets.length, 1);
  assert.equal(get(second.settings).calendarSets.length, 1);
  assert.notEqual(get(first.settings).calendarSets, get(second.settings).calendarSets);
  assert.equal(DEFAULT_SETTINGS.calendarSets.length, 0);
});

test("a missing active calendar falls back to an existing set", async () => {
  const { plugin } = setup();
  plugin.savedData = { calendarSets: [calendar("Existing")], activeCalendarSet: "Removed" };
  await plugin.loadSettings();
  assert.equal(plugin.calendarSetManager.getActiveId(), "Existing");
});

test("deleting the active calendar notifies subscribers and keeps a valid fallback", () => {
  const { plugin } = setup([calendar("A"), calendar("B")]);
  let updates = 0;
  plugin.settings.subscribe(() => updates++);
  plugin.settings.update(deleteCalendarSet("A"));
  assert.equal(updates, 2);
  assert.equal(get(plugin.settings).activeCalendarSet, "B");
  plugin.settings.update(deleteCalendarSet("B"));
  assert.equal(get(plugin.settings).calendarSets.length, 1);
});

test("asynchronous template read failures are caught", async () => {
  const { app } = setup();
  app.vault.files.set("template.md", new TFile("template.md"));
  app.vault.cachedRead = async () => { throw new Error("unreadable"); };
  const original = console.error;
  console.error = () => {};
  try { assert.equal(await getTemplateContents(app, "template.md"), ""); }
  finally { console.error = original; }
});
