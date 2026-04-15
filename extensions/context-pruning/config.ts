/**
 * Configuration for context pruning.
 *
 * Ported from OpenCode's compaction.ts constants (PRUNE_MINIMUM, PRUNE_PROTECT).
 *
 * Enable/disable via settings.json (global or project):
 *   { "contextPruning": { "enabled": false } }
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Thresholds (matching OpenCode defaults)
// ============================================================================

/**
 * Minimum tokens that must be prunable before we actually prune.
 * Prevents churn on small conversations. (OpenCode: 20_000)
 */
export const PRUNE_MINIMUM = 20_000;

/**
 * Token budget for "protected" recent tool outputs.
 * We walk backward through tool results, accumulating tokens.
 * Only outputs *beyond* this budget are eligible for pruning. (OpenCode: 40_000)
 */
export const PRUNE_PROTECT = 40_000;

/**
 * Number of most-recent user turns to never prune.
 * A "turn" starts at a user message and includes all subsequent
 * assistant/toolResult messages until the next user message. (OpenCode: 2)
 */
export const PROTECTED_TURNS = 2;

// ============================================================================
// Tool filtering
// ============================================================================

/**
 * Tool names whose outputs are never pruned, regardless of age.
 * Use this for tools whose results contain persistent context
 * (e.g., skill outputs, extension state).
 */
export const PROTECTED_TOOLS: readonly string[] = [];

/**
 * Tool names eligible for pruning.
 * If empty, all non-protected tools are prunable.
 * If non-empty, only listed tools are prunable.
 */
export const PRUNABLE_TOOLS: readonly string[] = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
];

// ============================================================================
// Types
// ============================================================================

export interface PruneConfig {
	/** Whether pruning is enabled. */
	enabled: boolean;
	/** Minimum tokens to collect before pruning. */
	pruneMinimum: number;
	/** Token budget for protected recent tool outputs. */
	pruneProtect: number;
	/** Number of recent user turns to always protect. */
	protectedTurns: number;
	/** Tool names that are never pruned. */
	protectedTools: readonly string[];
	/** Tool names eligible for pruning (empty = all non-protected). */
	prunableTools: readonly string[];
}

export interface PruneStats {
	/** Number of tool result messages pruned this pass. */
	messagesPruned: number;
	/** Estimated tokens freed by pruning. */
	tokensPruned: number;
	/** Total tool result tokens scanned. */
	totalToolTokens: number;
	/** Number of tool results protected (recent turns / protected tools). */
	messagesProtected: number;
}

/**
 * Default configuration assembled from constants above.
 */
export const DEFAULT_CONFIG: PruneConfig = {
	enabled: true,
	pruneMinimum: PRUNE_MINIMUM,
	pruneProtect: PRUNE_PROTECT,
	protectedTurns: PROTECTED_TURNS,
	protectedTools: PROTECTED_TOOLS,
	prunableTools: PRUNABLE_TOOLS,
};

// ============================================================================
// Settings loader
// ============================================================================

interface SettingsJson {
	contextPruning?: {
		enabled?: boolean;
	};
}

function readJsonSafe(path: string): SettingsJson | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Load `contextPruning.enabled` from settings.json.
 * Project settings override global settings.
 */
export function loadEnabledFromSettings(cwd: string): boolean | undefined {
	const globalSettings = readJsonSafe(join(homedir(), ".pi", "agent", "settings.json"));
	const projectSettings = readJsonSafe(join(cwd, ".pi", "settings.json"));

	// Project overrides global
	const projectEnabled = projectSettings?.contextPruning?.enabled;
	if (projectEnabled !== undefined) return projectEnabled;

	const globalEnabled = globalSettings?.contextPruning?.enabled;
	if (globalEnabled !== undefined) return globalEnabled;

	return undefined; // Use default (true)
}
