/**
 * Core pruning logic — pure function, no side effects.
 *
 * Implements OpenCode-style tool output pruning:
 *   1. Walk messages backward from newest
 *   2. Skip the most recent N user turns (keep their tool outputs intact)
 *   3. Stop at compactionSummary boundary (already summarized)
 *   4. Accumulate token counts of eligible toolResult messages
 *   5. Beyond PRUNE_PROTECT budget → mark for pruning
 *   6. Only prune if total prunable > PRUNE_MINIMUM
 *   7. Replace pruned content with a short marker
 *
 * The returned array is safe to send to the LLM — original messages
 * are not mutated (caller provides a structuredClone via the context event).
 */

import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { PruneConfig, PruneStats } from "./config.ts";

// AgentMessage is the union type used in context events.
// We import it for type annotations; at runtime we only inspect `.role`.
type AgentMessage = Parameters<typeof estimateTokens>[0];

// ============================================================================
// Marker text
// ============================================================================

/**
 * Build a human/LLM-readable marker for a pruned tool result.
 * Includes tool name and estimated token count so the LLM knows the
 * tool ran and roughly how much output it produced.
 */
function pruneMarker(toolName: string, tokens: number, args?: Record<string, unknown>): string {
	// Extract the most informative argument (path, command, pattern, etc.)
	let detail = "";
	if (args) {
		const key = args.path ?? args.command ?? args.pattern ?? args.query;
		if (typeof key === "string") {
			// Truncate long values
			const value = key.length > 80 ? `${key.slice(0, 77)}...` : key;
			detail = ` | ${Object.keys(args).find((k) => args[k] === key) ?? "arg"}="${value}"`;
		}
	}
	return `[output pruned — ~${tokens.toLocaleString()} tokens | ${toolName}${detail}]`;
}

// ============================================================================
// Helpers
// ============================================================================

/** Check if a tool is eligible for pruning given the config. */
function isPrunable(toolName: string, config: PruneConfig): boolean {
	// Never prune protected tools
	if (config.protectedTools.includes(toolName)) return false;
	// If prunable list is specified, only prune listed tools
	if (config.prunableTools.length > 0) return config.prunableTools.includes(toolName);
	// Otherwise prune everything not protected
	return true;
}

/**
 * Extract the tool call arguments for a given toolCallId from the preceding
 * assistant message. Used to build informative prune markers.
 */
function findToolCallArgs(
	messages: AgentMessage[],
	toolCallId: string,
	searchFromIndex: number,
): Record<string, unknown> | undefined {
	for (let i = searchFromIndex - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const content = (msg as { content: Array<{ type: string; id?: string; arguments?: Record<string, unknown> }> })
				.content;
			for (const block of content) {
				if (block.type === "toolCall" && block.id === toolCallId) {
					return block.arguments;
				}
			}
			// Only search the immediately preceding assistant message
			break;
		}
	}
	return undefined;
}

// ============================================================================
// Main pruning function
// ============================================================================

export interface PruneResult {
	messages: AgentMessage[];
	stats: PruneStats;
}

/**
 * Prune old tool outputs from the message array.
 *
 * IMPORTANT: This function mutates the provided messages in-place for
 * efficiency. The `context` event provides a structuredClone, so the
 * session file is never affected.
 */
export function pruneToolOutputs(messages: AgentMessage[], config: PruneConfig): PruneResult {
	const stats: PruneStats = {
		messagesPruned: 0,
		tokensPruned: 0,
		totalToolTokens: 0,
		messagesProtected: 0,
	};

	// Collect candidates: walk backward, track turns, respect boundaries
	interface Candidate {
		index: number;
		tokens: number;
		toolName: string;
		toolCallId: string;
	}

	const candidates: Candidate[] = [];
	let userTurns = 0;
	let protectedTokens = 0;
	let prunableTokens = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];

		// Count user turns
		if (msg.role === "user") {
			userTurns++;
			continue;
		}

		// Stop at compaction boundary — everything before is already summarized
		if (msg.role === "compactionSummary") {
			break;
		}

		// Only process tool results
		if (msg.role !== "toolResult") continue;

		const toolResult = msg as {
			role: "toolResult";
			toolName: string;
			toolCallId: string;
			content: Array<{ type: string; text?: string }>;
		};

		const tokens = estimateTokens(msg);
		stats.totalToolTokens += tokens;

		// Skip if within protected turns
		if (userTurns < config.protectedTurns) {
			stats.messagesProtected++;
			continue;
		}

		// Skip if tool is protected
		if (!isPrunable(toolResult.toolName, config)) {
			stats.messagesProtected++;
			continue;
		}

		// Accumulate into protected budget first, then prunable
		if (protectedTokens < config.pruneProtect) {
			protectedTokens += tokens;
			stats.messagesProtected++;
			continue;
		}

		// Beyond protection budget → candidate for pruning
		prunableTokens += tokens;
		candidates.push({
			index: i,
			tokens,
			toolName: toolResult.toolName,
			toolCallId: toolResult.toolCallId,
		});
	}

	// Only prune if we have enough to make it worthwhile
	if (prunableTokens < config.pruneMinimum || candidates.length === 0) {
		return { messages, stats };
	}

	// Apply pruning — replace content with marker
	for (const candidate of candidates) {
		const msg = messages[candidate.index] as {
			role: "toolResult";
			toolName: string;
			toolCallId: string;
			content: Array<{ type: string; text?: string }>;
			isError: boolean;
		};

		// Don't prune error results — they may contain important diagnostics
		if (msg.isError) continue;

		const args = findToolCallArgs(messages, candidate.toolCallId, candidate.index);
		const marker = pruneMarker(candidate.toolName, candidate.tokens, args);

		// Replace content with marker
		msg.content = [{ type: "text", text: marker }];

		stats.messagesPruned++;
		stats.tokensPruned += candidate.tokens;
	}

	return { messages, stats };
}
