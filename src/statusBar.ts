import * as vscode from "vscode";

/**
 * Cumulative token counters tracked across the current VS Code session.
 * Reset when a new conversation begins (no prior assistant turn).
 */
let cumulativeInputTokens = 0;
let cumulativeOutputTokens = 0;
let cumulativeCacheHitTokens = 0;
let cumulativeCacheMissTokens = 0;

/** Last-known prompt size for the active model (used to render the bar). */
let lastPromptTokens = 0;
let lastModelMaxInputTokens = 0;

/**
 * One streaming-usage record reported by the provider after a chat response.
 * Cache fields are populated by APIs that surface cache statistics
 * (e.g. DeepSeek's `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`).
 */
export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

let statusBarItem: vscode.StatusBarItem | undefined;

export function initStatusBar(
  context: vscode.ExtensionContext
): vscode.StatusBarItem {
  resetCumulativeCounters();
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  item.name = "OpenCode Go Token Usage";
  item.text = "$(symbol-numeric) OpenCode Go";
  item.tooltip = "OpenCode Go: no requests yet";
  context.subscriptions.push(item);
  item.show();
  statusBarItem = item;
  return item;
}

export function getStatusBarItem(): vscode.StatusBarItem | undefined {
  return statusBarItem;
}

/** Format a token count using K / M / B suffixes. */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000).toFixed(1) + "B";
  }
  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(1) + "M";
  }
  if (value >= 1_000) {
    return (value / 1_000).toFixed(1) + "K";
  }
  return value.toLocaleString();
}

/** Render a small textual progress bar (single-block + percentage). */
export function createProgressBar(used: number, max: number): string {
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const safeMax = max > 0 ? max : 1;
  const pct = Math.min((used / safeMax) * 100, 100);
  const idx = Math.min(
    Math.floor((pct / 100) * blocks.length),
    blocks.length - 1
  );
  return `${blocks[idx]} ${pct.toFixed(1)}%`;
}

/**
 * Update the visible status bar text based on the most recent prompt size and
 * the active model's input window. Call after each request completes.
 */
export function updateStatusBarText(): void {
  if (!statusBarItem) return;
  if (lastModelMaxInputTokens <= 0) {
    statusBarItem.text = "$(symbol-numeric) OpenCode Go";
    return;
  }
  const bar = createProgressBar(lastPromptTokens, lastModelMaxInputTokens);
  statusBarItem.text = `$(symbol-numeric) ${formatTokenCount(
    lastPromptTokens
  )} ${bar}`;
}

/**
 * Reset cumulative session counters. Called at startup and when a new
 * conversation begins (no prior assistant turns in the current request).
 */
export function resetCumulativeCounters(): void {
  cumulativeInputTokens = 0;
  cumulativeOutputTokens = 0;
  cumulativeCacheHitTokens = 0;
  cumulativeCacheMissTokens = 0;
  lastPromptTokens = 0;
  lastModelMaxInputTokens = 0;
}

/** Add the latest streaming usage to the cumulative counters. */
export function recordUsage(usage: StreamUsage): void {
  cumulativeInputTokens += usage.promptTokens;
  cumulativeOutputTokens += usage.completionTokens;
  if (typeof usage.cacheHitTokens === "number") {
    cumulativeCacheHitTokens += usage.cacheHitTokens;
  }
  if (typeof usage.cacheMissTokens === "number") {
    cumulativeCacheMissTokens += usage.cacheMissTokens;
  }
  lastPromptTokens = usage.promptTokens;
  updateCumulativeTooltip();
  updateStatusBarText();
}

/** Inform the bar of the active model so the progress bar has a denominator. */
export function setActiveModel(maxInputTokens: number): void {
  lastModelMaxInputTokens = maxInputTokens;
  updateStatusBarText();
}

/**
 * Detect a new conversation (no assistant messages yet) and reset counters.
 * Returns true when a reset happened.
 */
export function maybeResetForNewConversation(
  hasAssistantTurn: boolean
): boolean {
  if (!hasAssistantTurn) {
    resetCumulativeCounters();
    return true;
  }
  return false;
}

/** Refresh the tooltip with cumulative input/output and cache hit rate. */
export function updateCumulativeTooltip(): void {
  if (!statusBarItem) return;
  const arrowUp = "↑";
  const arrowDown = "↓";
  const lines: string[] = [];

  let inputLine = `${arrowUp} ${formatTokenCount(cumulativeInputTokens)}`;
  const totalCache = cumulativeCacheHitTokens + cumulativeCacheMissTokens;
  if (totalCache > 0) {
    const pct = Math.round((cumulativeCacheHitTokens / totalCache) * 100);
    inputLine += ` (${formatTokenCount(
      cumulativeCacheHitTokens
    )} cached, ${pct}%)`;
  }
  lines.push(inputLine);
  lines.push(`${arrowDown} ${formatTokenCount(cumulativeOutputTokens)}`);
  statusBarItem.tooltip = lines.join("\n");
}
