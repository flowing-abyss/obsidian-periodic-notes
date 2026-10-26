import { MarkdownView } from "obsidian";
import { PeriodicNotesCache } from "src/cache";
import PeriodicNotesPlugin from "src/main";
import type { SvelteComponent } from "svelte";

import Timeline from "./Timeline.svelte";

export default class TimelineManager {
  private btnComponents = new Map<MarkdownView, SvelteComponent>();
  private disposed = false;

  constructor(readonly plugin: PeriodicNotesPlugin, readonly cache: PeriodicNotesCache) {
    this.plugin.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      plugin.registerEvent(
        plugin.app.workspace.on("layout-change", this.onLayoutChange, this)
      );
      this.onLayoutChange();
    });
  }

  public cleanup() {
    this.disposed = true;
    for (const existingEl of this.btnComponents.values()) {
      existingEl.$destroy();
    }
    this.btnComponents.clear();
  }

  private onLayoutChange(): void {
    if (this.disposed) return;
    const openViews: MarkdownView[] = [];
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        openViews.push(leaf.view);
      }
    });

    // Clean up timelines on closed leaves
    for (const [view, existingEl] of this.btnComponents) {
      if (!openViews.includes(view)) {
        existingEl.$destroy();
        this.btnComponents.delete(view);
      }
    }

    // Add to any view that doesn't already have one
    for (const view of openViews) {
      if (!this.btnComponents.has(view)) {
        this.btnComponents.set(
          view,
          new Timeline({
            target: view.containerEl,
            props: {
              plugin: this.plugin,
              cache: this.cache,
              view,
            },
          })
        );
      }
    }
  }
}
