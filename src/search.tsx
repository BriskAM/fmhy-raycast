import {
  List,
  ActionPanel,
  Action,
  Icon,
  environment,
  showToast,
  Toast,
  getPreferenceValues,
} from "@raycast/api";
import { useState, useEffect, useMemo } from "react";
import fs from "node:fs";
import path from "node:path";
import { FMItem, SearchIndex } from "./types";
import { CATEGORY_PAGES } from "./constants";
import { fetchLatestCommitSha, fetchRawFileContent, fetchCommitCompareDiffs } from "./github";
import { parseMarkdownFile } from "./parser";

const INDEX_FILE = "fmhy-index.json";

interface Preferences {
  showNsfw: boolean;
}

export default function Command() {
  const [items, setItems] = useState<FMItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [syncProgress, setSyncProgress] = useState<number | null>(null);

  const preferences = getPreferenceValues<Preferences>();
  const indexPath = path.join(environment.supportPath, INDEX_FILE);

  // Ensure support directory exists
  const ensureSupportDir = () => {
    if (!fs.existsSync(environment.supportPath)) {
      fs.mkdirSync(environment.supportPath, { recursive: true });
    }
  };

  // Perform a full initial sync of all categories
  const performFullSync = async (latestSha: string) => {
    setIsLoading(true);
    ensureSupportDir();

    const allItems: FMItem[] = [];
    const total = CATEGORY_PAGES.length;

    for (let i = 0; i < total; i++) {
      const page = CATEGORY_PAGES[i];
      setSyncProgress(i / total);
      setSyncStatus(`Downloading ${page.name} (${i + 1}/${total})...`);

      try {
        const content = await fetchRawFileContent(page.path);
        const parsed = parseMarkdownFile(content, page.category);
        allItems.push(...parsed);
      } catch (error) {
        console.error(`Error syncing ${page.name}:`, error);
      }
    }

    const indexData: SearchIndex = {
      commitSha: latestSha,
      syncedAt: new Date().toISOString(),
      items: allItems,
    };

    fs.writeFileSync(indexPath, JSON.stringify(indexData));
    setItems(allItems);
    setIsLoading(false);
    setSyncProgress(null);
    setSyncStatus("");

    await showToast({
      style: Toast.Style.Success,
      title: "Index Synced",
      message: `Loaded ${allItems.length} resources from FMHY`,
    });
  };

  // Perform a background diff-based update check
  const checkAndSyncDiffs = async (cachedIndex: SearchIndex) => {
    try {
      const latestSha = await fetchLatestCommitSha();
      if (cachedIndex.commitSha === latestSha) {
        // Already up to date!
        return;
      }

      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Checking for updates...",
      });

      const diffs = await fetchCommitCompareDiffs(cachedIndex.commitSha, latestSha);
      const docsDiffs = diffs.filter(
        (d) => d.filename.startsWith("docs/") && d.filename.endsWith(".md")
      );

      if (docsDiffs.length === 0) {
        // No relevant changes in documentation folder
        // Just update cached commit sha
        const updatedIndex: SearchIndex = {
          ...cachedIndex,
          commitSha: latestSha,
          syncedAt: new Date().toISOString(),
        };
        fs.writeFileSync(indexPath, JSON.stringify(updatedIndex));
        toast.style = Toast.Style.Success;
        toast.title = "Search index up to date";
        return;
      }

      toast.title = `Syncing changes (${docsDiffs.length} files)...`;

      // Copy existing items
      let updatedItems = [...cachedIndex.items];

      for (const diff of docsDiffs) {
        const filename = diff.filename.replace("docs/", "");
        const categoryPage = CATEGORY_PAGES.find((p) => p.path === filename);
        const category = categoryPage ? categoryPage.category : filename.replace(".md", "");

        // Remove old items for this category
        updatedItems = updatedItems.filter((item) => item.category !== category);

        if (diff.status !== "removed") {
          try {
            const rawContent = await fetchRawFileContent(filename);
            const parsed = parseMarkdownFile(rawContent, category);
            updatedItems.push(...parsed);
          } catch (e) {
            console.error(`Error updating category ${category}:`, e);
          }
        }
      }

      const newIndex: SearchIndex = {
        commitSha: latestSha,
        syncedAt: new Date().toISOString(),
        items: updatedItems,
      };

      fs.writeFileSync(indexPath, JSON.stringify(newIndex));
      setItems(updatedItems);
      toast.style = Toast.Style.Success;
      toast.title = "FMHY Index updated!";
      toast.message = `Sync completed. Loaded ${updatedItems.length} resources.`;
    } catch (error) {
      console.error("Diff sync error:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Sync failed",
        message: "Failed to update index in background",
      });
    }
  };

  // Load index on mount, sync if needed
  useEffect(() => {
    const initIndex = async () => {
      try {
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath, "utf-8");
          const indexData = JSON.parse(content) as SearchIndex;
          setItems(indexData.items);
          setIsLoading(false);
          // Check for updates in the background
          checkAndSyncDiffs(indexData);
        } else {
          // No index exists, perform full sync
          const latestSha = await fetchLatestCommitSha();
          await performFullSync(latestSha);
        }
      } catch (error) {
        console.error("Failed to initialize FMHY index:", error);
        setIsLoading(false);
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to load index",
          message: "Check your internet connection and try again.",
        });
      }
    };

    initIndex();
  }, []);

  // Force manual rebuild of index
  const handleForceSync = async () => {
    try {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Refreshing index...",
      });
      const latestSha = await fetchLatestCommitSha();
      await performFullSync(latestSha);
      toast.style = Toast.Style.Success;
      toast.title = "Index refreshed!";
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Refresh failed",
        message: "Failed to perform a force sync.",
      });
    }
  };

  // Filter and sort items based on input, category dropdown, and NSFW preference
  const filteredItems = useMemo(() => {
    let result = items;

    // Filter out NSFW content if not allowed (e.g. any links from NSFW sources if they exist)
    if (!preferences.showNsfw) {
      result = result.filter(
        (item) =>
          item.category !== "nsfw" &&
          !item.subcategory.toLowerCase().includes("nsfw") &&
          !item.section.toLowerCase().includes("nsfw") &&
          !item.title.toLowerCase().includes("nsfw")
      );
    }

    if (selectedCategory !== "all") {
      result = result.filter((item) => item.category === selectedCategory);
    }

    if (searchText) {
      const query = searchText.toLowerCase().trim();

      // Helper function to check if the query matches a category/subcategory/section name
      // Prioritizes subcategory (H1) > section (H2) > category (file name)
      const getMetadataMatchScore = (item: FMItem) => {
        const sub = item.subcategory.toLowerCase();
        const sec = item.section.toLowerCase();
        const cat = item.category.toLowerCase();

        // Subcategory matches (H1) - highest priority
        if (sub === query) return 10;
        if (sub.startsWith(query)) return 9;
        if (sub.includes(query)) return 8;

        // Section matches (H2) - medium priority
        if (sec === query) return 7;
        if (sec.startsWith(query)) return 6;
        if (sec.includes(query)) return 5;

        // Category matches (Vitepress file name) - low priority
        if (cat === query) return 4;
        if (cat.startsWith(query)) return 3;
        if (cat.includes(query)) return 2;

        return 0;
      };

      // Helper function to check how well the query matches the tool's title
      const getTitleMatchScore = (item: FMItem) => {
        const title = item.title.toLowerCase();
        if (title === query) return 10;
        if (title.startsWith(query)) return 8;
        if (title.includes(query)) return 6;
        return 0;
      };

      // Check if there is any metadata (category/subcategory/section) matching the query
      const hasMetadataMatch = result.some((item) => getMetadataMatchScore(item) >= 5);

      if (hasMetadataMatch) {
        // Filter items that match in some way:
        const matched = result.filter(
          (item) =>
            getTitleMatchScore(item) > 0 ||
            getMetadataMatchScore(item) > 0 ||
            item.description.toLowerCase().includes(query) ||
            item.url.toLowerCase().includes(query)
        );

        // Find the single best title match
        let bestTitleItem: FMItem | null = null;
        let highestTitleScore = 0;

        matched.forEach((item) => {
          const score = getTitleMatchScore(item);
          if (score > highestTitleScore) {
            highestTitleScore = score;
            bestTitleItem = item;
          }
        });

        // Separate items
        const metadataItems: FMItem[] = [];
        const otherItems: FMItem[] = [];

        matched.forEach((item) => {
          if (bestTitleItem && item.id === bestTitleItem.id) return;

          const metaScore = getMetadataMatchScore(item);
          if (metaScore >= 5) {
            metadataItems.push(item);
          } else {
            otherItems.push(item);
          }
        });

        // Sort metadata matches: best match score first, then preserve original order
        metadataItems.sort((a, b) => {
          const aMeta = getMetadataMatchScore(a);
          const bMeta = getMetadataMatchScore(b);
          if (aMeta !== bMeta) return bMeta - aMeta;

          if (a.category !== b.category) {
            return a.category.localeCompare(b.category);
          }
          return (a.position ?? 0) - (b.position ?? 0);
        });

        // Sort other matches by starred
        otherItems.sort((a, b) => {
          const aStarred = a.starred ? 1 : 0;
          const bStarred = b.starred ? 1 : 0;
          if (aStarred !== bStarred) return bStarred - aStarred;
          return (a.position ?? 0) - (b.position ?? 0);
        });

        const finalResult: FMItem[] = [];
        if (bestTitleItem) {
          finalResult.push(bestTitleItem);
        }
        finalResult.push(...metadataItems);
        finalResult.push(...otherItems);

        return finalResult.slice(0, 200);
      } else {
        // Normal search (no category matches)
        const matched = result.filter(
          (item) =>
            getTitleMatchScore(item) > 0 ||
            item.description.toLowerCase().includes(query) ||
            item.section.toLowerCase().includes(query) ||
            item.subcategory.toLowerCase().includes(query) ||
            item.url.toLowerCase().includes(query)
        );

        // Sort: title exact -> title starts-with -> title contains -> starred -> rest
        return matched
          .sort((a, b) => {
            const aTitleScore = getTitleMatchScore(a);
            const bTitleScore = getTitleMatchScore(b);
            if (aTitleScore !== bTitleScore) return bTitleScore - aTitleScore;

            const aStarred = a.starred ? 1 : 0;
            const bStarred = b.starred ? 1 : 0;
            if (aStarred !== bStarred) return bStarred - aStarred;

            return (a.position ?? 0) - (b.position ?? 0);
          })
          .slice(0, 200);
      }
    } else {
      // Default sort (starred first, then original order)
      result = [...result].sort((a, b) => {
        const aStarred = a.starred ? 1 : 0;
        const bStarred = b.starred ? 1 : 0;
        if (aStarred !== bStarred) return bStarred - aStarred;
        return (a.position ?? 0) - (b.position ?? 0);
      });
    }

    return result.slice(0, 200); // Limit rendered elements for fluid performance
  }, [items, searchText, selectedCategory, preferences.showNsfw]);

  // Extract unique categories for dropdown filter
  const categoriesList = useMemo(() => {
    const map = new Map<string, string>();
    CATEGORY_PAGES.forEach((page) => {
      map.set(page.category, page.name);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, []);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={syncStatus || "Search FMHY tools, websites, guides..."}
      onSearchTextChange={setSearchText}
      throttle
      searchBarAccessory={
        categoriesList.length > 0 ? (
          <List.Dropdown
            tooltip="Filter by Category"
            storeValue={true}
            onChange={(newValue) => setSelectedCategory(newValue)}
          >
            <List.Dropdown.Item title="All Categories" value="all" />
            {categoriesList.map((cat) => (
              <List.Dropdown.Item key={cat.id} title={cat.name} value={cat.id} />
            ))}
          </List.Dropdown>
        ) : undefined
      }
    >
      {filteredItems.map((item) => (
        <List.Item
          key={item.id}
          title={item.title}
          subtitle={
            (item.subcategory ? item.subcategory : "") +
            (item.section ? ` › ${item.section}` : "")
          }
          accessories={[
            {
              text: item.description,
            },
            ...(item.starred ? [{ icon: Icon.Star, tooltip: "Starred Pick" }] : []),
          ]}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser url={item.url} title="Open Primary Link" />
              <Action.CopyToClipboard content={item.url} title="Copy Primary Link" />

              {/* Sub-section for Mirrors & Alternatives */}
              {(item.mirrors.length > 0 ||
                item.alternatives.length > 0 ||
                item.officialLinks.length > 0) && (
                <ActionPanel.Section title="Mirrors & Alternatives">
                  {item.mirrors.map((mirrorUrl, idx) => (
                    <Action.OpenInBrowser
                      key={`mirror-${idx}`}
                      url={mirrorUrl}
                      title={`Open Mirror ${idx + 2}`}
                      shortcut={{ modifiers: ["cmd"], key: (idx + 2).toString() as any }}
                    />
                  ))}
                  {item.alternatives.map((alt, idx) => (
                    <Action.OpenInBrowser
                      key={`alt-${idx}`}
                      url={alt.url}
                      title={`Open Alternative: ${alt.name}`}
                    />
                  ))}
                  {item.officialLinks.map((official, idx) => (
                    <Action.OpenInBrowser
                      key={`official-${idx}`}
                      url={official.url}
                      title={`Open ${official.name}`}
                    />
                  ))}
                </ActionPanel.Section>
              )}

              {/* Re-indexing Action */}
              <ActionPanel.Section title="Index Administration">
                <Action
                  title="Force Refresh Index"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                  onAction={handleForceSync}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
