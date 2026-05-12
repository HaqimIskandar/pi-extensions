/**
 * Pi jcodemunch Hooks Extension
 *
 * Bridges jcodemunch-mcp's capabilities to Pi's event system.
 * Provides 7 hooks that map Pi lifecycle events to jcodemunch operations:
 *
 * 1. PostToolUse auto-reindex → tool_result (edit/write)
 * 2. PreCompact snapshot      → session_before_compact
 * 3. SubagentStart orientation → before_agent_start
 * 4. Large-file read guard     → tool_call (read) — HARD BLOCK for indexed repos
 * 5. Bash exploration guard    → tool_call (bash) — HARD BLOCK for code grep/find/cat
 * 6. Edit guard               → tool_call (edit/write) — SOFT GATE advisory
 * 7. Turn-end diagnostics      → turn_end
 *
 * Config: ~/.pi/settings.json → jcodemunchHooks.minSizeBytes (default: 4096)
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { execFile } from "child_process";
import { existsSync, statSync, readFileSync } from "fs";
import { extname, join } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
	".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
	".go", ".rs", ".java", ".php", ".rb", ".cs", ".cshtml", ".razor",
	".cpp", ".c", ".h", ".hpp", ".cc", ".cxx", ".ino",
	".swift", ".kt", ".kts", ".scala", ".dart", ".lua", ".luau",
	".ex", ".exs", ".erl", ".hrl", ".vue", ".svelte", ".sql",
	".gd", ".gleam", ".nix", ".hcl", ".tf", ".proto", ".graphql", ".gql",
	".jl", ".r", ".R", ".hs", ".f90", ".f95", ".f03", ".f08",
	".groovy", ".pl", ".pm", ".bash", ".sh", ".zsh",
]);

const JCODEMUNCH_BIN = "jcodemunch";
const SETTINGS_PATH = join(process.env.HOME || "/home/six", ".pi", "settings.json");

/** Load minSizeBytes from ~/.pi/settings.json or env var fallback. */
function loadMinSizeBytes(): number {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
			if (settings.jcodemunchHooks?.minSizeBytes) {
				return settings.jcodemunchHooks.minSizeBytes;
			}
		}
	} catch { /* swallow */ }
	return parseInt(process.env.JCODEMUNCH_HOOK_MIN_SIZE || "4096", 10);
}

const MIN_SIZE_BYTES = loadMinSizeBytes();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCodeFile(filePath: string): boolean {
	return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function fileExistsAndLarge(filePath: string): boolean {
	try {
		return existsSync(filePath) && statSync(filePath).size >= MIN_SIZE_BYTES;
	} catch {
		return false;
	}
}

const SAFE_COMMAND_RE = /^(npm|yarn|pnpm|cargo|go |pytest|jest|vitest|rspec|mvn|gradle|git |docker|kubectl|uv |pip |brew |jcodemunch|uvx jcodemunch|sudo|systemctl|curl|wget|echo |mkdir|rm |cp |mv |chmod|df |du |free|ps |ls |pwd|which|whoami|id |uname|date |env |printenv)/;

const EXPLORATION_RE = /\b(grep|rg|cat|head|tail|awk|ag|ack)\b.*\.(py|js|ts|tsx|jsx|mjs|go|rs|java|rb|php|cs|cpp|c|h|swift|kt|scala|dart|lua|sql|sh|ex|hs)/i;
const FIND_EXPLORATION_RE = /\bfind\b.*\.(py|js|ts|tsx|jsx|mjs|go|rs|java|rb|php|cs|cpp|c|h|swift|kt|scala|dart|lua|sql|sh|ex|hs)/i;
const GREP_NOEXT_RE = /\bgrep\b.*-[rRn].*(src|lib|app|pkg|cmd|internal|server|client|core)/i;
const RG_DIR_RE = /\brg\b.*(src\/|lib\/|app\/|pkg\/|cmd\/|internal\/|server\/|client\/|core\/)/i;

/** Check if a bash command is code exploration that should use jcodemunch instead. */
function isBashCodeExploration(command: string): boolean {
	if (SAFE_COMMAND_RE.test(command.trim())) return false;
	return EXPLORATION_RE.test(command) || FIND_EXPLORATION_RE.test(command) || GREP_NOEXT_RE.test(command) || RG_DIR_RE.test(command);
}

/** Fire-and-forget spawn of jcodemunch CLI. Never throws. */
function spawnJcodemunch(args: string[]): void {
	try {
		const child = execFile(JCODEMUNCH_BIN, args, {
			timeout: 30000,
			maxBuffer: 1024 * 1024,
		});
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.on("error", () => { /* swallow */ });
	} catch { /* swallow */ }
}

/** Extract a quoted value from MUNCH format, handling "" escaping.
 *  Given input starting after the opening quote, returns [value, endIndex]. */
function extractMunchQuotedValue(text: string, start: number): [string, number] {
	let result = "";
	let i = start;
	while (i < text.length) {
		if (text[i] === '"') {
			// "" is an escaped quote, lone " is end of value
			if (i + 1 < text.length && text[i + 1] === '"') {
				result += '"';
				i += 2;
			} else {
				return [result, i + 1]; // skip closing quote
			}
		} else {
			result += text[i];
			i++;
		}
	}
	return [result, i];
}

/** Parse MUNCH key=value pairs from a line. Handles quoted values with "" escaping. */
function parseMunchKvLine(line: string): Record<string, string> {
	const result: Record<string, string> = {};
	let i = 0;
	while (i < line.length) {
		// Skip whitespace
		while (i < line.length && line[i] === ' ') i++;
		if (i >= line.length) break;

		// Read key ([\w.]+)
		const keyStart = i;
		while (i < line.length && /[\w.]/.test(line[i])) i++;
		const key = line.slice(keyStart, i);
		if (!key || i >= line.length || line[i] !== '=') { i++; continue; }
		i++; // skip '='

		// Read value
		if (i < line.length && line[i] === '"') {
			i++; // skip opening quote
			const [val, endIdx] = extractMunchQuotedValue(line, i);
			result[key] = val;
			i = endIdx;
		} else {
			// Unquoted value: read until whitespace
			const valStart = i;
			while (i < line.length && line[i] !== ' ') i++;
			result[key] = line.slice(valStart, i);
		}
	}
	return result;
}

/** Await jcodemunch CLI. Returns parsed JSON or MUNCH key-value map, or null on failure. */
async function runJcodemunch(args: string[]): Promise<Record<string, any> | null> {
	return new Promise((resolve) => {
		execFile(JCODEMUNCH_BIN, args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
			if (err || !stdout) { resolve(null); return; }
			const text = stdout.trim();

			// Try JSON first
			if (text.startsWith("{") || text.startsWith("[")) {
				try { resolve(JSON.parse(text)); return; }
				catch { /* fall through to MUNCH */ }
			}

			// Parse MUNCH format — key=value pairs from header/meta lines
			if (text.startsWith("#MUNCH/1")) {
				const result: Record<string, any> = {};
				for (const line of text.split("\n")) {
					if (line.startsWith("#MUNCH") || line.startsWith("s,") || line.startsWith("t,") || line.startsWith("f,") || line.startsWith("d,")) continue;
					if (!line.trim()) continue;

					const pairs = parseMunchKvLine(line);
					for (const [key, val] of Object.entries(pairs)) {
						// __json.* fields contain embedded JSON (with ""→" unescaping already done)
						if (key.startsWith("__json.")) {
							const jsonKey = key.slice(7);
							try { result[jsonKey] = JSON.parse(val); }
							catch { result[jsonKey] = val; }
						} else if (/^-?\d+$/.test(val)) {
							result[key] = parseInt(val, 10);
						} else if (/^-?\d+\.\d+$/.test(val)) {
							result[key] = parseFloat(val);
						} else {
							result[key] = val;
						}
					}
				}
				resolve(Object.keys(result).length > 0 ? result : null);
				return;
			}

			resolve(null);
		});
	});
}

// ---------------------------------------------------------------------------
// Repo tracking
// ---------------------------------------------------------------------------

// Track edited files this turn for diagnostics
const turnEditedFiles: string[] = [];

// Track which files have had edit advisory shown (once per session)
const editAdvisoryShown = new Set<string>();

// Track whether session has an indexed repo (for briefing + read guard)
let cachedRepoId: string | null = null;
let cachedIndexedRoot: string | null = null; // filesystem root of indexed repo
let repoIdChecked = false;

// Per-file repo cache: avoids repeated resolve-repo calls for files in same repo
const fileRepoCache = new Map<string, { repo: string; root: string } | null>();

async function resolveRepoForCwd(cwd: string): Promise<string | null> {
	if (repoIdChecked) return cachedRepoId;
	repoIdChecked = true;
	const result = await runJcodemunch(["resolve-repo", "--path", cwd]);
	if (result?.repo && result?.indexed) {
		cachedRepoId = result.repo;
		cachedIndexedRoot = cwd;
		return cachedRepoId;
	}
	return null;
}

/** Resolve the indexed repo for a specific file path (not CWD). Uses per-file cache. */
async function resolveRepoForFile(filePath: string): Promise<{ repo: string; root: string } | null> {
	const absPath = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
	// Check cache by file's parent directory
	const dir = absPath.substring(0, absPath.lastIndexOf("/"));
	if (fileRepoCache.has(dir)) return fileRepoCache.get(dir)!;

	const result = await runJcodemunch(["resolve-repo", "--path", absPath]);
	const entry = (result?.repo && result?.indexed) ? { repo: result.repo as string, root: result.source_root as string || dir } : null;
	fileRepoCache.set(dir, entry);
	return entry;
}

/** Check if a file path falls under the session's cached indexed repo root. */
function isUnderIndexedRepo(filePath: string, cwd: string): boolean {
	if (!cachedIndexedRoot) return false;
	// Resolve relative paths against cwd
	const absFile = filePath.startsWith("/") ? filePath : join(cwd, filePath);
	return absFile.startsWith(cachedIndexedRoot + "/") || absFile === cachedIndexedRoot;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {

	// ── Hook 1: PostToolUse Auto-Reindex ──────────────────────────
	// After edit/write on code files, spawn background index-file
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.isError) return;

		const input = event.input as Record<string, any> | undefined;
		const filePath = input?.path || input?.file_path;

		if (!filePath || !isCodeFile(filePath)) return;

		// Track for turn-end diagnostics
		turnEditedFiles.push(filePath);

		// Fire-and-forget reindex
		spawnJcodemunch(["index-file", "--path", filePath]);
	});

	// ── Hook 2: PreCompact Snapshot Injection ─────────────────────
	// Before compaction, build a session snapshot and inject it
	pi.on("session_before_compact", async (_event, ctx) => {
		try {
			const snapshot = await runJcodemunch(["get-session-snapshot", "--max-files", "15", "--max-edits", "15", "--max-searches", "10"]);
			if (!snapshot) return;

			let snapshotText = "";
			if (snapshot.snapshot && typeof snapshot.snapshot === "string") {
				snapshotText = snapshot.snapshot;
			} else if (snapshot.content && Array.isArray(snapshot.content)) {
				snapshotText = snapshot.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
			}

			if (!snapshotText) return;

			return {
				compaction: {
					summary: `## jcodemunch Session Snapshot\n\n${snapshotText}`,
					firstKeptEntryId: _event.preparation.firstKeptEntryId,
					tokensBefore: _event.preparation.tokensBefore,
				},
			};
		} catch { /* snapshot failure must not block compaction */ }
	});

	// ── Hook 3: SubagentStart Orientation Briefing ────────────────
	// Inject repo briefing before agent starts
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const repoId = await resolveRepoForCwd(ctx.cwd);
			if (!repoId) return;

			const outline = await runJcodemunch(["get-repo-outline", "--repo", repoId]);
			if (!outline) return;

			let briefing = "## jcodemunch Repo Briefing\n";
			briefing += `**Repo:** ${repoId}\n`;
			if (outline.file_count) briefing += `**Files:** ${outline.file_count}\n`;
			if (outline.symbol_count) briefing += `**Symbols:** ${outline.symbol_count}\n`;
			if (outline.languages && typeof outline.languages === "object") {
				const langs = Object.entries(outline.languages)
					.sort(([, a]: any, [, b]: any) => (b as number) - (a as number))
					.slice(0, 5)
					.map(([lang, count]) => `${lang} (${count})`)
					.join(", ");
				briefing += `**Languages:** ${langs}\n`;
			}

			briefing += "\nUse jcodemunch tools (search_symbols, get_file_outline, get_symbol_source) for code navigation instead of raw file reads.";

			return {
				message: {
					customType: "jcodemunch-briefing",
					content: briefing,
					display: false,
				},
			};
		} catch { /* briefing failure must not block agent start */ }
	});

	// ── Hook 4: Large-File Read Guard — HARD BLOCK ───────────────
	// Blocks native read on large code files in indexed repos.
	// No offset/limit bypass — pagination doesn't excuse reading large code files.
	// Forces agent to use jcodemunch: get_file_outline, get_symbol_source, etc.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return;

		const input = event.input as Record<string, any> | undefined;
		const filePath = input?.path;

		if (!filePath || !isCodeFile(filePath)) return;

		// Resolve repo from the target FILE path, not CWD
		const fileRepo = await resolveRepoForFile(filePath);
		if (!fileRepo) return;

		// Block ALL reads on large files — including offset/limit
		if (!fileExistsAndLarge(filePath)) return;

		const fileName = filePath.split("/").pop() || filePath;
		const repoRef = fileRepo.repo;

		return {
			block: true,
			reason: `⛔ jcodemunch read guard: "${fileName}" is a large code file in indexed repo. ` +
				`Use jcodemunch tools instead:\n` +
				`  • get_file_outline --repo ${repoRef} --path "${filePath}"\n` +
				`  • get_symbol_source --repo ${repoRef} --symbol_id <id>\n` +
				`  • search_symbols --repo ${repoRef} --query <term>`,
		} satisfies ToolCallEventResult;
	});

	// ── Hook 5: Bash Exploration Guard — HARD BLOCK ──────────────
	// Blocks bash commands that look like code exploration (grep/find/cat on code files).
	// Redirects to jcodemunch search_symbols, search_text, get_file_outline instead.
	// Safe commands (npm, git, docker, etc.) pass through untouched.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const input = event.input as Record<string, any> | undefined;
		const command = input?.command;
		if (!command || typeof command !== "string") return;

		if (!isBashCodeExploration(command)) return;

		return {
			block: true,
			reason: `⛔ jcodemunch bash guard: code exploration detected. Use jcodemunch tools instead:\n` +
				`  • search_symbols --query <term>\n` +
				`  • search_text --query <term>\n` +
				`  • get_file_outline --file-path <path>\n` +
				`  • find_references --identifier <name>`,
		} satisfies ToolCallEventResult;
	});

	// ── Hook 6: Edit Guard — SOFT GATE ───────────────────────────
	// Soft gate on edit/write in indexed repos. Allows the edit but injects an
	// advisory suggesting jcodemunch tools for safer context before modifying.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const input = event.input as Record<string, any> | undefined;
		const filePath = input?.path;
		if (!filePath || !isCodeFile(filePath)) return;

		const fileRepo = await resolveRepoForFile(filePath);
		if (!fileRepo) return;

		// Only show advisory once per file per session
		if (editAdvisoryShown.has(filePath)) return;
		editAdvisoryShown.add(filePath);

		const fileName = filePath.split("/").pop() || filePath;
		pi.sendMessage({
			customType: "jcodemunch-edit-advisory",
			content: `⚠️ jcodemunch edit guard: editing "${fileName}" in indexed repo. Consider consulting first:\n` +
				`  • get_symbol_source — confirm you're editing the right implementation\n` +
				`  • get_file_outline — see all symbols before touching this file\n` +
				`  • get_blast_radius — understand what breaks if you change this\n` +
				`  • find_references — find all call sites that may need updating`,
			display: true,
		});
	});

	// ── Hook 7: Turn-End Diagnostics ──────────────────────────────
	// After a turn with code edits, surface dead code / issues
	pi.on("turn_end", async (_event, ctx) => {
		if (turnEditedFiles.length === 0) return;

		const editedThisTurn = [...turnEditedFiles];
		turnEditedFiles.length = 0;

		try {
			const repoId = await resolveRepoForCwd(ctx.cwd);
			if (!repoId) return;

			const deadCode = await runJcodemunch([
				"find-dead-code", "--repo", repoId,
				"--granularity", "symbol", "--min-confidence", "0.9",
			]);

			if (!deadCode) return;

			const deadSymbols = deadCode.dead_symbols || deadCode.results || [];
			const relevantDead = Array.isArray(deadSymbols)
				? deadSymbols.filter((s: any) =>
					editedThisTurn.some(f => s.file && f.endsWith(s.file)),
				)
				: [];

			if (relevantDead.length > 0) {
				const names = relevantDead.slice(0, 5).map((s: any) => s.name || s).join(", ");
				const msg = `jcodemunch: ${relevantDead.length} potentially dead symbol(s) near edited files: ${names}`;
				if (ctx.hasUI) {
					ctx.ui.notify(msg, "info");
				} else {
					pi.sendMessage({ customType: "jcodemunch-diagnostics", content: msg, display: true });
				}
			}
		} catch { /* diagnostics failure must not block */ }
	});

	// ── Reset repo cache + confirm extension load ────────────────
	pi.on("session_start", async (_event, ctx) => {
		cachedRepoId = null;
		cachedIndexedRoot = null;
		repoIdChecked = false;
		turnEditedFiles.length = 0;
		editAdvisoryShown.clear();

		// Confirm extension is active via TUI status bar + message bridge
		const minKB = Math.round(MIN_SIZE_BYTES / 1024);
		const statusMsg = `jcodemunch hooks active (7 hooks: read ≥${minKB}KB, bash guard, edit advisory)`;

		if (ctx.hasUI) {
			ctx.ui.setStatus("jcodemunch-hooks", statusMsg);
		}

		pi.sendMessage({
			customType: "jcodemunch-session-start",
			content: `🔧 ${statusMsg}`,
			display: true,
		});
	});
}
