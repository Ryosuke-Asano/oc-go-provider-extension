import * as vscode from "vscode";
import type { SecretFinding } from "./secretScan";

export interface UsageMetrics {
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
}

interface ContextSnapshot {
  model?: string;
  contextTokens: number;
  contextLimit: number;
  estimated: boolean;
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeCacheHit: number;
  cumulativeCacheMiss: number;
  redactionCount: number;
}

const LAST_CONTEXT_SNAPSHOT_KEY = "opencode-go.lastContextSnapshot";

export interface SecretScanReport {
  apiFormat: "openai" | "anthropic";
  findings: SecretFinding[];
  redacted: boolean;
  at: number;
}

class OcGoStatusBar {
  private _item: vscode.StatusBarItem;
  private _cumulativeInput = 0;
  private _cumulativeOutput = 0;
  private _cumulativeCacheHit = 0;
  private _cumulativeCacheMiss = 0;
  private _maxInputTokens: number | undefined;
  private _model: string | undefined;
  private _contextTokens: number | undefined;
  private _contextEstimated = true;
  private _restoredSnapshot = false;
  private _lastScan: SecretScanReport | undefined;
  private _redactionCount = 0;

  constructor(context: vscode.ExtensionContext) {
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this._item.command = "opencode-go.manage";
    this._item.text = "$(hubot) OC Go";
    this._item.tooltip = "OpenCode Go Provider";
    this._item.show();
    context.subscriptions.push(this._item);
    const snapshot = context.globalState.get<ContextSnapshot>(
      LAST_CONTEXT_SNAPSHOT_KEY
    );
    if (snapshot) {
      this._model = snapshot.model;
      this._contextTokens = snapshot.contextTokens;
      this._maxInputTokens = snapshot.contextLimit;
      this._contextEstimated = snapshot.estimated;
      this._cumulativeInput = snapshot.cumulativeInput ?? 0;
      this._cumulativeOutput = snapshot.cumulativeOutput ?? 0;
      this._cumulativeCacheHit = snapshot.cumulativeCacheHit ?? 0;
      this._cumulativeCacheMiss = snapshot.cumulativeCacheMiss ?? 0;
      this._redactionCount = snapshot.redactionCount ?? 0;
      this._restoredSnapshot = true;
      this._updateText();
      this._updateTooltip();
    }
    this._state = context.globalState;
  }

  private readonly _state: vscode.Memento;

  setActiveModel(maxInputTokens: number, model: string): void {
    this._maxInputTokens = maxInputTokens;
    this._model = model;
    this._contextTokens = undefined;
    this._restoredSnapshot = false;
    this._updateText();
    this._updateTooltip();
  }

  setPromptTokens(tokens: number): void {
    this._contextTokens = tokens;
    this._contextEstimated = true;
    this._restoredSnapshot = false;
    this._persistContextSnapshot();
    this._updateText();
    this._updateTooltip();
  }

  recordUsage(usage: UsageMetrics): void {
    this._cumulativeInput += usage.prompt_tokens ?? 0;
    this._cumulativeOutput += usage.completion_tokens ?? 0;
    this._cumulativeCacheHit += usage.cache_hit_tokens ?? 0;
    this._cumulativeCacheMiss += usage.cache_miss_tokens ?? 0;
    if (usage.prompt_tokens > 0) {
      this._contextTokens = usage.prompt_tokens;
      this._contextEstimated = false;
      this._restoredSnapshot = false;
      this._persistContextSnapshot();
    }
    this._updateText();
    this._updateTooltip();
  }

  maybeResetForNewConversation(hasAssistantTurn: boolean): void {
    if (!hasAssistantTurn) {
      this._cumulativeInput = 0;
      this._cumulativeOutput = 0;
      this._cumulativeCacheHit = 0;
      this._cumulativeCacheMiss = 0;
      this._updateText();
    }
  }

  recordSecretScan(report: Omit<SecretScanReport, "at">): void {
    this._lastScan = { ...report, at: Date.now() };
    this._redactionCount = report.findings.length;
    this._persistContextSnapshot();
    this._updateText();
    this._updateTooltip();
  }

  getLastScan(): SecretScanReport | undefined {
    return this._lastScan;
  }

  private _updateText(): void {
    const parts: string[] = ["$(hubot) OC Go"];
    if (this._redactionCount > 0) {
      parts.push(`$(shield) ${this._redactionCount}`);
    }
    if (
      this._contextTokens !== undefined &&
      this._maxInputTokens !== undefined
    ) {
      const context = `${this._contextEstimated ? "~" : ""}${this._fmt(this._contextTokens)}/${this._fmt(this._maxInputTokens)}`;
      parts.push(this._restoredSnapshot ? `last ${context}` : context);
    }
    if (this._cumulativeInput > 0 || this._cumulativeOutput > 0) {
      parts.push(
        `${this._fmt(this._cumulativeInput)}in/${this._fmt(this._cumulativeOutput)}out`
      );
    }
    this._item.text = parts.join(" ");
  }

  private _updateTooltip(): void {
    const lines: string[] = ["OpenCode Go Token Usage"];
    if (
      this._contextTokens !== undefined &&
      this._maxInputTokens !== undefined
    ) {
      lines.push(
        `Context: ${this._fmt(this._contextTokens)}/${this._fmt(this._maxInputTokens)}${this._contextEstimated ? " (estimated)" : ""}`
      );
      if (this._model) lines.push(`Model: ${this._model}`);
      if (this._restoredSnapshot) {
        lines.push("Restored from the last OpenCode session");
      }
    }
    lines.push(`Input: ${this._fmt(this._cumulativeInput)}`);
    lines.push(`Output: ${this._fmt(this._cumulativeOutput)}`);
    if (this._cumulativeCacheHit > 0 || this._cumulativeCacheMiss > 0) {
      const total = this._cumulativeCacheHit + this._cumulativeCacheMiss;
      const rate =
        total > 0 ? Math.round((this._cumulativeCacheHit / total) * 100) : 0;
      lines.push(`Cache hit rate: ${rate}%`);
    }
    if (this._lastScan) {
      const ts = new Date(this._lastScan.at).toLocaleString();
      lines.push("");
      lines.push("Secret scan");
      lines.push(
        `  Last: ${ts} (${this._lastScan.apiFormat}) — ` +
          `${this._lastScan.findings.length} finding(s), ` +
          (this._lastScan.redacted ? "redacted" : "passthrough")
      );
      const rules = Array.from(
        new Set(this._lastScan.findings.map((f) => f.ruleId))
      );
      if (rules.length > 0) {
        lines.push(`  Rules: ${rules.join(", ")}`);
      }
      lines.push('  Run "OpenCode Go: Show Secret Scan Log" for details.');
    }
    this._item.tooltip = lines.join("\n");
  }

  private _fmt(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  private _persistContextSnapshot(): void {
    if (
      this._contextTokens === undefined ||
      this._maxInputTokens === undefined
    ) {
      return;
    }
    const snapshot: ContextSnapshot = {
      model: this._model,
      contextTokens: this._contextTokens,
      contextLimit: this._maxInputTokens,
      estimated: this._contextEstimated,
      cumulativeInput: this._cumulativeInput,
      cumulativeOutput: this._cumulativeOutput,
      cumulativeCacheHit: this._cumulativeCacheHit,
      cumulativeCacheMiss: this._cumulativeCacheMiss,
      redactionCount: this._redactionCount,
    };
    void this._state
      .update(LAST_CONTEXT_SNAPSHOT_KEY, snapshot)
      .then(undefined, () => undefined);
  }

  dispose(): void {
    this._item.dispose();
  }
}

let _statusBar: OcGoStatusBar | undefined;

export function initStatusBar(context: vscode.ExtensionContext): void {
  _statusBar = new OcGoStatusBar(context);
}

export function statusBarRecordUsage(usage: UsageMetrics): void {
  _statusBar?.recordUsage(usage);
}

/** Set the active model and its total context-window limit. */
export function statusBarSetActiveModel(
  maxInputTokens: number,
  model: string
): void {
  _statusBar?.setActiveModel(maxInputTokens, model);
}

export function statusBarSetPromptTokens(tokens: number): void {
  _statusBar?.setPromptTokens(tokens);
}

export function statusBarMaybeReset(hasAssistantTurn: boolean): void {
  _statusBar?.maybeResetForNewConversation(hasAssistantTurn);
}

export function statusBarRecordSecretScan(
  report: Omit<SecretScanReport, "at">
): void {
  _statusBar?.recordSecretScan(report);
}

export function statusBarGetLastScan(): SecretScanReport | undefined {
  return _statusBar?.getLastScan();
}
