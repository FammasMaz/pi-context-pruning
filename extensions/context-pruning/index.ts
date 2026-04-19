/**
 * Context Pruning Extension for Pi
 *
 * Implements OpenCode-style proactive tool output pruning to reduce token usage.
 * Uses the `context` event to non-destructively prune old tool outputs before
 * each LLM call. Session file keeps full history — only the LLM sees pruned content.
 *
 * Install:
 *   pi install /path/to/pi-context-pruning
 *
 * Disable via settings.json (global or project):
 *   { "contextPruning": { "enabled": false } }
 *
 * Commands:
 *   /prune        — Force prune on next LLM call (bypasses minimum threshold)
 *   /prune-stats  — Show pruning statistics for the current session
 *   /prune-config — Show current pruning configuration
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONFIG, loadEnabledFromSettings, type PruneConfig, type PruneStats } from "./config.ts";
import { pruneToolOutputs } from "./pruner.ts";

export default function contextPruning(pi: ExtensionAPI) {
	const config: PruneConfig = { ...DEFAULT_CONFIG };

	// Cumulative stats across the session
	let sessionStats: PruneStats = emptyStats();
	let lastPruneStats: PruneStats | null = null;
	let pruneCount = 0;
	let forceNextPrune = false;

	function emptyStats(): PruneStats {
		return {
			messagesPruned: 0,
			tokensPruned: 0,
			totalToolTokens: 0,
			messagesProtected: 0,
		};
	}

	// ========================================================================
	// Reset on session start, reload enabled setting
	// ========================================================================

	pi.on("session_start", async (_event, ctx) => {
		sessionStats = emptyStats();
		lastPruneStats = null;
		pruneCount = 0;
		forceNextPrune = false;

		// Reload enabled setting from settings.json
		const enabled = loadEnabledFromSettings(ctx.cwd);
		config.enabled = enabled ?? DEFAULT_CONFIG.enabled;

		if (!config.enabled) {
			ctx.ui.setStatus("context-pruning", "🔪 context pruning disabled");
		}
	});

	// ========================================================================
	// Core: prune tool outputs before each LLM call
	// ========================================================================

	pi.on("context", async (event, ctx) => {
		if (!config.enabled && !forceNextPrune) return undefined;

		// If forced, bypass the minimum threshold
		const effectiveConfig = forceNextPrune ? { ...config, enabled: true, pruneMinimum: 0 } : config;
		forceNextPrune = false;

		const result = pruneToolOutputs(event.messages, effectiveConfig);

		if (result.stats.messagesPruned > 0) {
			// Accumulate session stats
			sessionStats.messagesPruned += result.stats.messagesPruned;
			sessionStats.tokensPruned += result.stats.tokensPruned;
			sessionStats.totalToolTokens = result.stats.totalToolTokens;
			sessionStats.messagesProtected = result.stats.messagesProtected;
			lastPruneStats = result.stats;
			pruneCount++;

			ctx.ui.setStatus("context-pruning", `🔪 ~${formatTokens(sessionStats.tokensPruned)} pruned`);
			return { messages: result.messages };
		}

		if (result.stats.totalToolTokens > 0) {
			ctx.ui.setStatus("context-pruning", `🔪 ${formatTokens(result.stats.totalToolTokens)} scanned`);
		}

		return undefined; // Pass through unchanged
	});

	// ========================================================================
	// Commands
	// ========================================================================

	pi.registerCommand("prune-stats", {
		description: "Show context pruning statistics for this session",
		handler: async (_args, ctx) => {
			if (!config.enabled) {
				ctx.ui.notify("Context pruning is disabled. Enable in settings.json:\n{ \"contextPruning\": { \"enabled\": true } }", "info");
				return;
			}

			if (pruneCount === 0) {
				ctx.ui.notify("No pruning has occurred yet this session.", "info");
				return;
			}

			const lines = [
				`Context Pruning Stats`,
				`─────────────────────`,
				`Prune passes:        ${pruneCount}`,
				`Messages pruned:     ${sessionStats.messagesPruned}`,
				`Tokens pruned:       ~${formatTokens(sessionStats.tokensPruned)}`,
				`Total tool tokens:   ~${formatTokens(sessionStats.totalToolTokens)}`,
				`Messages protected:  ${sessionStats.messagesProtected}`,
				``,
			];

			if (lastPruneStats) {
				lines.push(
					`Last prune pass:`,
					`  Messages:  ${lastPruneStats.messagesPruned}`,
					`  Tokens:    ~${formatTokens(lastPruneStats.tokensPruned)}`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("prune-toggle", {
		description: "Toggle context pruning on/off for this session",
		handler: async (_args, ctx) => {
			config.enabled = !config.enabled;
			if (config.enabled) {
				ctx.ui.setStatus("context-pruning", "🔪 context pruning enabled");
				ctx.ui.notify("Context pruning enabled", "info");
			} else {
				ctx.ui.setStatus("context-pruning", "🔪 context pruning disabled");
				ctx.ui.notify("Context pruning disabled", "info");
			}
		},
	});

	pi.registerCommand("prune", {
		description: "Force prune tool outputs on the next LLM call (bypasses minimum threshold)",
		handler: async (_args, ctx) => {
			forceNextPrune = true;
			ctx.ui.notify(
				"Forced prune queued — will prune on next LLM call (minimum threshold bypassed).",
				"info",
			);
			ctx.ui.setStatus("context-pruning", "🔪 forced prune pending...");
		},
	});

	pi.registerCommand("prune-config", {
		description: "Show current context pruning configuration",
		handler: async (_args, ctx) => {
			const lines = [
				`Context Pruning Config`,
				`──────────────────────`,
				`Enabled:          ${config.enabled}`,
				`Prune minimum:    ${formatTokens(config.pruneMinimum)} tokens`,
				`Prune protect:    ${formatTokens(config.pruneProtect)} tokens`,
				`Protected turns:  ${config.protectedTurns}`,
				`Protected tools:  ${config.protectedTools.length === 0 ? "(none)" : config.protectedTools.join(", ")}`,
				`Prunable tools:   ${config.prunableTools.length === 0 ? "(all non-protected)" : config.prunableTools.join(", ")}`,
				``,
				`Toggle in settings.json:`,
				`  { "contextPruning": { "enabled": ${!config.enabled} } }`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// ============================================================================
// Helpers
// ============================================================================

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}
