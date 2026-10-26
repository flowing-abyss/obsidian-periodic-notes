import sortBy from "lodash/sortBy";
import type { Moment } from "moment";
import {
  App,
  Component,
  normalizePath,
  parseFrontMatterEntry,
  TAbstractFile,
  TFile,
  TFolder,
  type CachedMetadata,
} from "obsidian";

import { DEFAULT_FORMAT } from "./constants";
import type PeriodicNotesPlugin from "./main";
import { getLooselyMatchedDate } from "./parser";
import { getDateInput } from "./settings/validation";
import { granularities, type Granularity, type PeriodicConfig } from "./types";
import { getPossibleFormats } from "./utils";

export type MatchType = "filename" | "frontmatter" | "date-prefixed";

export interface PeriodicNoteMatchMatchData {
  /* where was the date found */
  matchType: MatchType;
  /* XXX: keep ZK matches in the cache, should this be separate from formats with HH:mm in them? */
  /* just collect this for now, not 100% sure how it will be used. */
  exact: boolean;
  // other ideas of match data:
  // - filename without date (unparsed tokens)
  // - time?: string
}

function compareGranularity(a: Granularity, b: Granularity) {
  const idxA = granularities.indexOf(a);
  const idxB = granularities.indexOf(b);
  if (idxA === idxB) return 0;
  if (idxA < idxB) return -1;
  return 1;
}

export interface PeriodicNoteCachedMetadata {
  calendarSet: string;
  filePath: string;
  date: Moment;
  granularity: Granularity;
  canonicalDateStr: string;

  /* "how" the match was made */
  matchData: PeriodicNoteMatchMatchData;
}

function getCanonicalDateString(_granularity: Granularity, date: Moment): string {
  return date.toISOString();
}

function isInFolder(file: TFile, folder: string | undefined): boolean {
  const path = normalizePath(folder || "/");
  return path === "/" || path === "" || file.path.startsWith(`${path}/`);
}

export class PeriodicNotesCache extends Component {
  // Map the full filename to
  public cachedFiles: Map<string, Map<string, PeriodicNoteCachedMetadata>>;
  private disposed = false;

  constructor(readonly app: App, readonly plugin: PeriodicNotesPlugin) {
    super();
    this.cachedFiles = new Map();

    this.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      console.info("[Periodic Notes] initializing cache");
      this.initialize();
      this.registerEvent(this.app.vault.on("create", this.resolve, this));
      this.registerEvent(this.app.vault.on("rename", this.resolveRename, this));
      this.registerEvent(this.app.vault.on("delete", this.resolveDelete, this));
      this.registerEvent(
        this.app.metadataCache.on("changed", this.resolveChangedMetadata, this)
      );
      this.registerEvent(
        this.app.workspace.on("periodic-notes:settings-updated", this.reset, this)
      );
    });
  }

  onunload(): void {
    this.disposed = true;
    this.cachedFiles.clear();
  }

  public reset(): void {
    console.info("[Periodic Notes] reseting cache");
    this.cachedFiles.clear();
    this.initialize();
  }

  public initialize(): void {
    const visited = new Set<TFile>();
    const recurseChildren = (rootFolder: TAbstractFile | null) => {
      if (!(rootFolder instanceof TFolder)) return;
      for (const c of rootFolder.children) {
        if (c instanceof TFile && !visited.has(c)) {
          visited.add(c);
          this.resolve(c);
          const metadata = this.app.metadataCache.getFileCache(c);
          if (metadata) this.resolveChangedMetadata(c, "", metadata);
        } else if (c instanceof TFolder) {
          recurseChildren(c);
        }
      }
    };

    for (const calendarSet of this.plugin.calendarSetManager.getCalendarSets()) {
      const activeGranularities = granularities.filter((g) => calendarSet[g]?.enabled);
      for (const granularity of activeGranularities) {
        const config = calendarSet[granularity] as PeriodicConfig;
        const rootFolder = this.app.vault.getAbstractFileByPath(
          normalizePath(config.folder || "/")
        );

        // Scan for filename matches
        recurseChildren(rootFolder);
      }
    }
  }

  private resolveChangedMetadata(
    file: TFile,
    _data: string,
    cache: CachedMetadata
  ): void {
    if (file.extension !== "md") return;
    const previous = this.find(file.path);
    // Metadata may have been removed or changed. Rebuild the filename fallback
    // before applying the current frontmatter.
    for (const cache of this.cachedFiles.values()) cache.delete(file.path);
    this.resolve(file);
    const manager = this.plugin.calendarSetManager;
    // Check if file matches any calendar set
    calendarsets: for (const calendarSet of manager.getCalendarSets()) {
      const activeGranularities = granularities.filter((g) => calendarSet[g]?.enabled);
      if (activeGranularities.length === 0) continue calendarsets;

      granularities: for (const granularity of activeGranularities) {
        if (!isInFolder(file, calendarSet[granularity]?.folder)) continue granularities;
        const frontmatterEntry = parseFrontMatterEntry(cache.frontmatter, granularity);
        if (!frontmatterEntry) continue granularities;

        const format = DEFAULT_FORMAT[granularity];
        let date: Moment;
        if (typeof frontmatterEntry === "string") {
          // e.g. `day: 2022-02-02`
          date = window.moment(frontmatterEntry, format, true);
          if (date.isValid()) {
            this.set(calendarSet.id, file.path, {
              calendarSet: calendarSet.id,
              filePath: file.path,
              date,
              granularity,
              canonicalDateStr: getCanonicalDateString(granularity, date),
              matchData: {
                exact: true,
                matchType: "frontmatter",
              },
            });
            continue calendarsets;
          }
        }
      }
    }
    const metadata = this.find(file.path) ?? previous;
    if (metadata) this.app.workspace.trigger("periodic-notes:resolve", metadata.granularity, file);
  }

  private resolveRename(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFile) {
      const previous = this.find(oldPath);
      this.removePath(oldPath);
      this.resolve(file);
      const metadata = this.app.metadataCache.getFileCache(file);
      if (metadata) this.resolveChangedMetadata(file, "", metadata);
      if (previous) this.app.workspace.trigger("periodic-notes:resolve", previous.granularity, file);
    } else if (file instanceof TFolder) {
      for (const child of file.children) {
        this.resolveRename(child, `${oldPath}/${child.name}`);
      }
      this.removePath(oldPath);
    }
  }

  private removePath(path: string): void {
    for (const cache of this.cachedFiles.values()) {
      for (const filePath of cache.keys()) {
        if (filePath === path || filePath.startsWith(`${path}/`)) cache.delete(filePath);
      }
    }
  }

  private resolveDelete(file: TAbstractFile): void {
    const previous = this.find(file.path);
    if (file instanceof TFolder) {
      for (const child of file.children) this.resolveDelete(child);
    }
    this.removePath(file.path);
    if (previous) this.app.workspace.trigger("periodic-notes:resolve", previous.granularity, file);
  }

  private resolve(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const manager = this.plugin.calendarSetManager;

    // Check if file matches any calendar set
    calendarsets: for (const calendarSet of manager.getCalendarSets()) {
      const activeGranularities = granularities.filter((g) => calendarSet[g]?.enabled);
      if (activeGranularities.length === 0) continue calendarsets;

      // 'frontmatter' entries should supercede 'filename'
      const existingEntry = this.cachedFiles.get(calendarSet.id)?.get(file.path);
      if (existingEntry && existingEntry.matchData.matchType === "frontmatter") {
        continue calendarsets;
      }

      granularities: for (const granularity of activeGranularities) {
        if (!isInFolder(file, calendarSet[granularity]?.folder)) continue granularities;

        const formats = getPossibleFormats(calendarSet, granularity);
        const dateInputStr = getDateInput(file, formats[0], granularity);
        const date = window.moment(dateInputStr, formats, true);
        if (date.isValid()) {
          const metadata = {
            calendarSet: calendarSet.id,
            filePath: file.path,
            date,
            granularity,
            canonicalDateStr: getCanonicalDateString(granularity, date),
            matchData: {
              exact: true,
              matchType: "filename",
            },
          } as PeriodicNoteCachedMetadata;
          this.set(calendarSet.id, file.path, metadata);

          this.app.workspace.trigger("periodic-notes:resolve", granularity, file);
          continue calendarsets;
        }
      }

      const nonStrictDate = activeGranularities.some((g) => isInFolder(file, calendarSet[g]?.folder))
        ? getLooselyMatchedDate(file.basename)
        : null;
      if (nonStrictDate) {
        this.set(calendarSet.id, file.path, {
          calendarSet: calendarSet.id,
          filePath: file.path,
          date: nonStrictDate.date,
          granularity: nonStrictDate.granularity,
          canonicalDateStr: getCanonicalDateString(
            nonStrictDate.granularity,
            nonStrictDate.date
          ),
          matchData: {
            exact: false,
            matchType: "filename",
          },
        });

        this.app.workspace.trigger(
          "periodic-notes:resolve",
          nonStrictDate.granularity,
          file
        );
        continue;
      }
    }
  }

  /**
   *
   * Get a periodic note from the cache
   *
   * @param calendarSet
   * @param granularity
   * @param targetDate
   */
  public getPeriodicNote(
    calendarSet: string,
    granularity: Granularity,
    targetDate: Moment
  ): TFile | null {
    const metadata = this.cachedFiles.get(calendarSet);
    if (metadata) {
      for (const [filePath, cacheData] of metadata) {
        if (
          cacheData.granularity === granularity &&
          cacheData.matchData.exact === true &&
          cacheData.date.isSame(targetDate, granularity)
        ) {
          const file = this.app.vault.getAbstractFileByPath(filePath);
          if (file instanceof TFile) return file;
        }
      }
    }

    return null;
  }

  /**
   *
   * Get all periodic notes from the cache
   *
   * @param calendarSet
   * @param granularity
   * @param targetDate
   * @param includeFinerGranularities?
   */
  public getPeriodicNotes(
    calendarSet: string,
    granularity: Granularity,
    targetDate: Moment,
    includeFinerGranularities = false
  ): PeriodicNoteCachedMetadata[] {
    const matches: PeriodicNoteCachedMetadata[] = [];
    const metadata = this.cachedFiles.get(calendarSet);
    if (metadata) {
      for (const [, cacheData] of metadata) {
        if (
          (granularity === cacheData.granularity ||
            (includeFinerGranularities &&
              compareGranularity(cacheData.granularity, granularity) <= 0)) &&
          cacheData.date.isSame(targetDate, granularity)
        ) {
          matches.push(cacheData);
        }
      }
    }

    return matches;
  }

  private set(
    calendarSet: string,
    filePath: string,
    metadata: PeriodicNoteCachedMetadata
  ) {
    let cache = this.cachedFiles.get(calendarSet);
    if (!cache) {
      cache = new Map();
      this.cachedFiles.set(calendarSet, cache);
    }

    cache.set(filePath, metadata);
  }

  public isPeriodic(targetPath: string, granularity?: Granularity): boolean {
    for (const [, calendarSetCache] of this.cachedFiles) {
      const metadata = calendarSetCache.get(targetPath);
      if (!metadata) continue;

      if (!granularity) return true;
      if (granularity && granularity === metadata.granularity) {
        return true;
      }
    }

    return false;
  }

  public find(
    filePath: string | undefined,
    calendarSet?: string
  ): PeriodicNoteCachedMetadata | null {
    if (!filePath) return null;

    // If a calendar set is passed, only check there
    if (calendarSet) {
      const cache = this.cachedFiles.get(calendarSet);
      return cache?.get(filePath) ?? null;
    }

    // Otherwise, check all calendar sets, starting with the active one
    const activeCache = this.cachedFiles.get(
      this.plugin.calendarSetManager.getActiveId()
    );
    const metadata = activeCache?.get(filePath);
    if (metadata) {
      return metadata;
    }

    // ... all other caches
    for (const [, calendarSetCache] of this.cachedFiles) {
      const metadata = calendarSetCache.get(filePath);
      if (metadata) {
        return metadata;
      }
    }
    return null;
  }

  public findAdjacent(
    calendarSet: string,
    filePath: string,
    direction: "forwards" | "backwards"
  ): PeriodicNoteCachedMetadata | null {
    const currMetadata = this.find(filePath, calendarSet);
    if (!currMetadata) return null;

    const granularity = currMetadata.granularity;
    const cache = this.cachedFiles.get(calendarSet)?.values() ?? [];

    const sortedCache = sortBy(
      Array.from(cache).filter((m) => m.granularity === granularity),
      ["canonicalDateStr"]
    );
    const activeNoteIndex = sortedCache.findIndex((m) => m.filePath === filePath);

    const offset = direction === "forwards" ? 1 : -1;
    return sortedCache[activeNoteIndex + offset];
  }
}
