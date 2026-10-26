export class Events {
  events = new Map();
  on(name, callback, ctx) {
    const ref = { name, callback, ctx };
    if (!this.events.has(name)) this.events.set(name, new Set());
    this.events.get(name).add(ref);
    return ref;
  }
  offref(ref) { this.events.get(ref.name)?.delete(ref); }
  trigger(name, ...args) {
    for (const ref of this.events.get(name) ?? []) ref.callback.apply(ref.ctx, args);
  }
  count(name) { return this.events.get(name)?.size ?? 0; }
}

export class Component {
  _loaded = false;
  _children = [];
  registrations = [];
  async load() { this._loaded = true; await this.onload?.(); }
  unload() {
    for (const child of this._children) child.unload();
    this.onunload?.();
    for (const cleanup of this.registrations.splice(0)) cleanup();
    this._loaded = false;
  }
  addChild(child) {
    this._children.push(child);
    if (this._loaded) child.load();
    return child;
  }
  register(callback) { this.registrations.push(callback); }
  registerEvent(ref) { this.register(() => ref.owner.offref(ref)); }
}

// EventRef's owner is private to the real host; the mock keeps it explicit.
const on = Events.prototype.on;
Events.prototype.on = function (...args) {
  const ref = on.apply(this, args);
  ref.owner = this;
  return ref;
};

export class Plugin extends Component {
  constructor(app) { super(); this.app = app; }
  async loadData() { return this.savedData ?? null; }
  async saveData(data) { this.savedData = structuredClone(data); }
  addCommand() {}
  addSettingTab() {}
  addRibbonIcon() { return { detach() {}, addEventListener() {} }; }
}
export class PluginSettingTab { hide() {} }
export class App {}
export class Modal {}
export class SuggestModal {}
export class FuzzySuggestModal {}
export class Menu {}
export class Scope {}
export class DailyNotesPlugin {}
export class Notice {}
export const Platform = { isMacOS: false };
export function addIcon() {}
export function setIcon(element) {
  if (!element) throw new TypeError("Icon target is missing");
}
export function parseFrontMatterEntry(frontmatter, key) { return frontmatter?.[key]; }
export function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "") || "/";
}

export class TAbstractFile {
  constructor(path) { this.path = path; }
  get name() { return this.path.split("/").pop(); }
}
export class TFolder extends TAbstractFile { children = []; }
export class TFile extends TAbstractFile {
  constructor(path, contents = "text") { super(path); this.contents = contents; }
  get extension() { return this.name.split(".").pop(); }
  get basename() { return this.name.slice(0, -(this.extension.length + 1)); }
  get stat() { return { size: this.contents.length }; }
}
export class MarkdownView {
  constructor() { this.containerEl = {}; }
}

export function createApp() {
  const vault = new Events();
  const root = new TFolder("/");
  const files = new Map([["/", root]]);
  const attach = (file) => {
    files.set(file.path, file);
    const parentPath = file.path.split("/").slice(0, -1).join("/") || "/";
    const parent = files.get(parentPath);
    if (parent && parent !== file) parent.children.push(file);
    return file;
  };
  Object.assign(vault, {
    files, createCalls: 0,
    getAbstractFileByPath: (path) => files.get(normalizePath(path)) ?? null,
    async createFolder(path) {
      path = normalizePath(path);
      if (files.has(path)) throw new Error("Folder already exists");
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent && !files.has(parent)) await vault.createFolder(parent);
      const folder = attach(new TFolder(path));
      vault.trigger("create", folder);
      return folder;
    },
    async create(path, data) {
      if (files.has(path)) throw new Error("File already exists");
      vault.createCalls++;
      const file = attach(new TFile(path, data));
      vault.trigger("create", file);
      return file;
    },
    async read(file) { return file.contents; },
    async cachedRead(file) { return file.contents; },
    async modify(file, contents) { file.contents = contents; },
    async process(file, transform) { return file.contents = transform(file.contents); },
    getConfig() {},
  });
  const metadataCache = new Events();
  metadataCache.caches = new Map();
  metadataCache.getFileCache = (file) => metadataCache.caches.get(file);
  metadataCache.getFirstLinkpathDest = (path) => files.get(path);
  const workspace = new Events();
  Object.assign(workspace, {
    ready: true, readyCallbacks: [], leaves: [], opened: [],
    onLayoutReady(callback) {
      if (workspace.ready) callback();
      else workspace.readyCallbacks.push(callback);
    },
    iterateAllLeaves(callback) { workspace.leaves.forEach(callback); },
    getUnpinnedLeaf() { return { openFile: async (file) => { workspace.opened.push(file); } }; },
    splitActiveLeaf() { return workspace.getUnpinnedLeaf(); },
  });
  const internalPlugins = { plugins: {}, getPluginById(id) { return this.plugins[id]; } };
  return { vault, workspace, metadataCache, internalPlugins, commands: { removeCommand() {} }, plugins: { getPlugin() {} } };
}
