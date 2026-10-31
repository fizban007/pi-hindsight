/**
 * Hindsight Self-Hosted Extension for Pi
 * Fully autonomous memory via lifecycle hooks.
 */
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { Type } from "@sinclair/typebox";
// ---------------------------------------------------------------------------
// Debug Logging
// ---------------------------------------------------------------------------
const DEBUG = process.env.HINDSIGHT_DEBUG === "1";
const LOG_PATH = join(homedir(), ".hindsight", "debug.log");
let sessionCwd = process.cwd();
let currentSessionId = null;
function log(msg) {
    if (!DEBUG)
        return;
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        mkdirSync(join(homedir(), ".hindsight"), { recursive: true });
        appendFileSync(LOG_PATH, line);
    }
    catch (_) { }
}
// ---------------------------------------------------------------------------
// Extension liveness
// ---------------------------------------------------------------------------
// Pi invalidates an extension runtime when its session is replaced (newSession,
// fork, switchSession) or when the process tears down — /reload, /exit, and
// one-shot `pi -p` runs (subagents, scripts) all end this way. Every runtime
// method asserts liveness and then throws, so work that resolves after that
// point cannot paint UI or send messages: there is no session left to paint on.
//
// Probe instead of catching, so a late retain report is dropped quietly rather
// than crashing the shutdown path with a stale-ctx error.
function extensionIsLive(pi) {
    try {
        if (typeof pi.getActiveTools !== "function")
            return true;
        pi.getActiveTools();
        return true;
    }
    catch {
        return false;
    }
}
// Paint the outcome of a retain (status badge and/or next-turn message).
// Shared by the async and sync paths so both report identically.
function emitRetainReport(pi, ctx, outcome) {
    if (!extensionIsLive(pi)) {
        log(`agent_settled: retain report dropped - extension runtime gone (session ${outcome.sessionId ?? "unknown"}), retain itself already committed`);
        return;
    }
    const config = getConfig();
    const feedback = config?.retain_feedback;
    const showMessage = feedback === "message" || feedback === "both";
    const showStatus = feedback === "status" || feedback === "both" || !feedback;
    const badge = `Memorized: ${outcome.retainSuccessCount}/${outcome.retainEligibleCount}`;
    try {
        if (outcome.allFailed) {
            if (showStatus)
                ctx.ui.setStatus("hindsight", badge);
            if (feedback !== "none") {
                pi.sendMessage({ customType: "hindsight-retain-failed", content: "", display: true }, { deliverAs: "nextTurn" });
            }
            return;
        }
        ctx.ui.setStatus("hindsight", showStatus ? badge : undefined);
        if (showMessage) {
            pi.sendMessage({
                customType: "hindsight-retain",
                content: "",
                display: true,
                details: { banks: outcome.succeededBanks },
            }, { deliverAs: "nextTurn" });
        }
    }
    catch (e) {
        const detail = e instanceof Error ? e.message.slice(0, 80) : String(e);
        log(`agent_settled: retain report skipped (${detail})`);
    }
}
function parseConfigFile(filePath) {
    const raw = readFileSync(filePath, "utf-8");
    const config = {};
    for (const line of raw.split("\n")) {
        const match = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*["']?(.*?)["']?\s*$/);
        if (match)
            config[match[1]] = match[2];
    }
    return config;
}
function getConfig() {
    try {
        const globalCfgPath = join(homedir(), ".hindsight", "config");
        if (!existsSync(globalCfgPath))
            return null;
        const global = parseConfigFile(globalCfgPath);
        // Project-level override: .hindsight/config in CWD
        const localCfgPath = join(sessionCwd, ".hindsight", "config");
        const local = existsSync(localCfgPath) ? parseConfigFile(localCfgPath) : {};
        const merged = applyAliases({ ...global, ...local });
        applyEnvOverrides(merged);
        const recallTypesRaw = merged.recall_types;
        const recall_types = recallTypesRaw
            ? recallTypesRaw.split(",").map((t) => t.trim()).filter(Boolean)
            : ["observation"];
        const recall_budget = merged.recall_budget || "mid";
        const recall_max_tokens = merged.recall_max_tokens ? parseInt(merged.recall_max_tokens, 10) : undefined;
        const recall_timeout = merged.recall_timeout ? parseInt(merged.recall_timeout, 10) : undefined;
        const async_retain = merged.async_retain === "false" ? false : true;
        const retain_feedback = merged.retain_feedback || "status";
        const recall_enabled = merged.recall_enabled === "false" ? false : true;
        const retain_enabled = merged.retain_enabled === "false" ? false : true;
        const homedir_project = merged.homedir_project === "false" ? false : true;
        const bank_scope = merged.bank_scope === "session" ? "session" : "project";
        const bank_namespace = merged.bank_namespace !== undefined ? merged.bank_namespace : undefined;
        const session_bank_ttl_days = merged.session_bank_ttl_days ? parseInt(merged.session_bank_ttl_days, 10) : undefined;
        return {
            api_url: merged.api_url,
            api_key: merged.api_key,
            global_bank: merged.global_bank,
            project_bank_id: merged.project_bank_id,
            recall_types,
            recall_budget,
            recall_max_tokens,
            recall_timeout,
            async_retain,
            retain_feedback,
            recall_enabled,
            retain_enabled,
            homedir_project,
            bank_scope,
            bank_namespace,
            session_bank_ttl_days,
        };
    }
    catch (e) {
        return null;
    }
}
function writeConfigValue(filePath, key, value) {
    mkdirSync(join(filePath, ".."), { recursive: true });
    let lines = [];
    if (existsSync(filePath)) {
        lines = readFileSync(filePath, "utf-8").split("\n");
    }
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const idx = lines.findIndex(l => pattern.test(l));
    const newLine = `${key} = "${value}"`;
    if (idx >= 0) {
        lines[idx] = newLine;
    }
    else {
        while (lines.length > 0 && lines[lines.length - 1].trim() === "")
            lines.pop();
        lines.push(newLine);
    }
    writeFileSync(filePath, lines.join("\n") + "\n");
}
// Legacy key aliases: old_key → canonical_key
const CONFIG_ALIASES = {
    bank_id: "global_bank",
    max_tokens: "recall_max_tokens",
};
function applyAliases(raw) {
    const result = { ...raw };
    for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
        if (result[oldKey] !== undefined && result[newKey] === undefined) {
            result[newKey] = result[oldKey];
        }
    }
    return result;
}
function detectLegacyKeys() {
    const issues = [];
    const globalCfgPath = join(homedir(), ".hindsight", "config");
    const localCfgPath = join(sessionCwd, ".hindsight", "config");
    const isHomeDir = sessionCwd === homedir();
    const files = [globalCfgPath];
    if (!isHomeDir && existsSync(localCfgPath))
        files.push(localCfgPath);
    for (const file of files) {
        if (!existsSync(file))
            continue;
        const raw = parseConfigFile(file);
        for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
            if (raw[oldKey] !== undefined && raw[newKey] === undefined) {
                issues.push({ file, key: oldKey, canonical: newKey });
            }
        }
    }
    return issues;
}
function migrateConfigFile(filePath) {
    const migrated = [];
    if (!existsSync(filePath))
        return migrated;
    let lines = readFileSync(filePath, "utf-8").split("\n");
    for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
        const pattern = new RegExp(`^(\\s*)${oldKey}(\\s*=)`);
        const idx = lines.findIndex(l => pattern.test(l));
        if (idx >= 0) {
            // Only migrate if canonical key doesn't already exist
            const hasCanonical = lines.some(l => new RegExp(`^\\s*${newKey}\\s*=`).test(l));
            if (!hasCanonical) {
                lines[idx] = lines[idx].replace(pattern, `$1${newKey}$2`);
                migrated.push(`${oldKey} → ${newKey}`);
            }
        }
    }
    if (migrated.length > 0) {
        writeFileSync(filePath, lines.join("\n"));
    }
    return migrated;
}
function getConfigWithSource() {
    const globalCfgPath = join(homedir(), ".hindsight", "config");
    const localCfgPath = join(sessionCwd, ".hindsight", "config");
    const isHomeDir = sessionCwd === homedir();
    const globalRaw = existsSync(globalCfgPath) ? parseConfigFile(globalCfgPath) : {};
    const localRaw = (!isHomeDir && existsSync(localCfgPath)) ? parseConfigFile(localCfgPath) : {};
    const global = applyAliases(globalRaw);
    const local = applyAliases(localRaw);
    const merged = { ...global, ...local };
    applyEnvOverrides(merged); // reflect env overrides in the /hindsight settings view
    return { global, local, merged, isHomeDir };
}
// ---------------------------------------------------------------------------
// Environment variable overrides (omp-compatible bank contract)
// ---------------------------------------------------------------------------
// omp reads HINDSIGHT_BANK_ID / HINDSIGHT_SCOPING directly from the environment
// (env beats config). Honoring the same variables here keeps the two memory
// implementations interchangeable when a launcher exports them per agent
// (e.g. agent wrappers that already steer omp this way). Precedence:
// environment > project config > global config > `project-<dirname>` default.
//
//   HINDSIGHT_BANK_ID           Replaces the bank root. With
//                               bank_scope=session it is the root that session
//                               banks are derived from; with scope=project it
//                               is the exact bank.
//   HINDSIGHT_BANK_SCOPE        "session" or "project" — overrides bank_scope.
//   HINDSIGHT_BANK_NAMESPACE    Overrides bank_namespace.
//   HINDSIGHT_SCOPING=global    Additionally replaces global_bank with the same
//                               id, collapsing recall + retain into one flat
//                               bank per agent (omp's "global" scoping). Also
//                               pins the exact bank, disabling session scope.
//   HINDSIGHT_SCOPING=per-project|per-project-tagged
//                               Pins project scoping; the configured
//                               global_bank stays in the recall mix.
//   Any other HINDSIGHT_SCOPING value is ignored.
//
// HINDSIGHT_RETAIN_EVERY_N_TURNS (omp) has no equivalent here: retain runs at
// agent_end on every turn, so it is deliberately not read.
//
// Without HINDSIGHT_BANK_ID this only applies the scope/namespace overrides —
// config-driven setups are otherwise unaffected.
export function applyEnvOverrides(merged) {
    const scope = process.env.HINDSIGHT_BANK_SCOPE?.trim();
    if (scope === "session" || scope === "project")
        merged.bank_scope = scope;
    if (process.env.HINDSIGHT_BANK_NAMESPACE !== undefined) {
        merged.bank_namespace = process.env.HINDSIGHT_BANK_NAMESPACE.trim();
    }
    const bank = process.env.HINDSIGHT_BANK_ID?.trim();
    if (!bank)
        return;
    const scoping = (process.env.HINDSIGHT_SCOPING || "").trim();
    merged.project_bank_id = bank;
    // An explicitly selected bank must also work from the home directory.
    merged.homedir_project = "true";
    if (scoping === "global") {
        merged.global_bank = "";
        // An explicitly pinned bank has no session suffix — omp semantics.
        merged.bank_scope = "project";
    }
    else if (scoping === "per-project" || scoping === "per-project-tagged") {
        merged.bank_scope = "project";
    }
}
// ---------------------------------------------------------------------------
// Bank resolution
// ---------------------------------------------------------------------------
// A bank id is the unit of isolation: everything in one bank is recalled
// together. With bank_scope=session every Pi session gets its own bank, so two
// concurrent sessions can never read each other's turns.
//
// Session banks always carry a namespace — the machine identity, by default the
// hostname. Without it, two machines that share a Hindsight server (and sync
// ~/.pi, and therefore session ids) would derive the same bank id for the same
// session and silently share memory. The `sess-` prefix marks banks this
// extension owns, which is what makes /hindsight prune safe.
//
//   sess-<namespace>-<project>-<session-tail>
//   sess-<project_bank_id>-<session-tail>      (explicit root)
//
// The final segment is the random tail of the session UUID, never its prefix:
// UUIDv7 prefixes encode a millisecond timestamp, so two sessions started in the
// same ~65s window agree on their first 8 hex characters.
const MAX_BANK_SEGMENT = 32;
export function sanitizeBankSegment(value) {
    const cleaned = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return cleaned.slice(0, MAX_BANK_SEGMENT).replace(/-+$/g, "") || "unknown";
}
export function getBankNamespace(config) {
    const configured = config?.bank_namespace;
    if (configured !== undefined) {
        return configured.trim() === "" ? "" : sanitizeBankSegment(configured);
    }
    return sanitizeBankSegment(hostname());
}
export function getProjectSlug(cwd = sessionCwd) {
    if (cwd === homedir())
        return "home";
    return sanitizeBankSegment(basename(cwd) || "/");
}
export function getSessionSuffix(sessionId) {
    const raw = (sessionId || "").trim();
    if (!raw)
        return "unknown";
    const tail = raw.split("-").pop() || raw;
    const cleaned = tail.replace(/[^a-zA-Z0-9]/g, "");
    return (cleaned || sanitizeBankSegment(raw)).slice(-12);
}
function getBankRoot(config, cwd = sessionCwd) {
    if (config.project_bank_id)
        return sanitizeBankSegment(config.project_bank_id);
    const ns = getBankNamespace(config);
    const slug = getProjectSlug(cwd);
    return ns ? `${ns}-${slug}` : slug;
}
export function getBankScope(config) {
    return config.bank_scope === "session" ? "session" : "project";
}
export function getProjectBank(config, cwd = sessionCwd) {
    if (config?.project_bank_id)
        return config.project_bank_id;
    const slug = getProjectSlug(cwd);
    // Project-scope naming stays byte-identical to older releases unless a
    // namespace was configured explicitly. Session banks are always namespaced.
    if (!config || config.bank_namespace === undefined)
        return `project-${slug}`;
    const ns = getBankNamespace(config);
    return ns ? `project-${ns}-${slug}` : `project-${slug}`;
}
export function getSessionBank(config, sessionId = currentSessionId, cwd = sessionCwd) {
    return `sess-${getBankRoot(config, cwd)}-${getSessionSuffix(sessionId)}`;
}
/** Prefix shared by every session bank this config owns, across projects. */
export function getSessionBankPrefix(config) {
    if (config.project_bank_id)
        return `sess-${sanitizeBankSegment(config.project_bank_id)}-`;
    const ns = getBankNamespace(config);
    return ns ? `sess-${ns}-` : null;
}
function isHomeDirSession() {
    return sessionCwd === homedir();
}
export function getRecallBanks(config, sessionId = currentSessionId) {
    if (getBankScope(config) === "session") {
        const banks = [getSessionBank(config, sessionId)];
        // A configured global bank is shared on purpose (cross-project learnings),
        // so it stays in the mix. Leaving it unset is the true-isolation default.
        if (config.global_bank)
            banks.push(config.global_bank);
        return banks;
    }
    const banks = new Set();
    if (config.global_bank)
        banks.add(config.global_bank);
    // Skip project bank in homedir when homedir_project is disabled
    if (!(isHomeDirSession() && config.homedir_project === false)) {
        banks.add(getProjectBank(config));
    }
    return Array.from(banks);
}
export function getRetainBanks(config, prompt, sessionId = currentSessionId) {
    const optInGlobal = !!config.global_bank && (prompt.includes("#global") || prompt.includes("#me"));
    if (getBankScope(config) === "session") {
        const banks = [getSessionBank(config, sessionId)];
        if (optInGlobal)
            banks.push(config.global_bank);
        return banks;
    }
    const banks = new Set();
    const skipProject = isHomeDirSession() && config.homedir_project === false;
    if (!skipProject) {
        banks.add(getProjectBank(config));
    }
    // When homedir_project=false, skip auto-retain entirely — explicit hindsight_retain still works
    // Opt-in for global bank retention
    if (optInGlobal) {
        banks.add(config.global_bank);
    }
    return Array.from(banks);
}
function getLastUserMessage(ctx, fallbackPrompt) {
    try {
        const entries = ctx.sessionManager?.getEntries() || [];
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.type === "message" && e.message?.role === "user") {
                const content = e.message.content;
                if (typeof content === "string")
                    return content;
                if (Array.isArray(content)) {
                    // Join text blocks only. JSON.stringify would send the wrapper (and
                    // any base64 image payload) to the reranker as the query.
                    const text = content
                        .filter((block) => block?.type === "text" && typeof block.text === "string")
                        .map((block) => block.text)
                        .join("\n")
                        .trim();
                    if (text)
                        return text;
                }
            }
        }
    }
    catch (e) { }
    return fallbackPrompt;
}
async function getBankMission(config, bank) {
    try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/config`, {
            headers: { "Authorization": `Bearer ${config.api_key || ""}` }
        });
        if (!res.ok)
            return null;
        const data = await res.json();
        return data?.config?.reflect_mission || null;
    }
    catch (_) {
        return null;
    }
}
async function checkBankConfig(config, bank) {
    try {
        // The bank profile endpoint was removed in Hindsight 0.10; GET /config is
        // the supported way to check that a bank exists and that auth works.
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/config`, {
            headers: { "Authorization": `Bearer ${config.api_key || ""}` }
        });
        if (res.status === 404 || res.status === 410) {
            // Session banks are created on first retain. A missing bank means it
            // does not exist yet, not that auth or the server is broken.
            return { ok: true, mission: null, missing: true };
        }
        if (res.status === 401 || res.status === 403)
            return { ok: false, authError: true };
        if (!res.ok)
            return { ok: false, authError: false };
        const data = await res.json();
        return { ok: true, mission: data?.config?.reflect_mission || null };
    }
    catch (_) {
        return { ok: false, authError: false };
    }
}
async function getServerHealth(config) {
    try {
        const res = await fetch(`${config.api_url}/health`, {
            headers: { "Authorization": `Bearer ${config.api_key || ""}` }
        });
        return { ok: res.ok, status: res.status };
    }
    catch (_) {
        return { ok: false };
    }
}
async function getBankStats(config, bank) {
    try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/stats`, {
            headers: { "Authorization": `Bearer ${config.api_key || ""}` }
        });
        if (!res.ok)
            return null;
        return await res.json();
    }
    catch (_) {
        return null;
    }
}
async function listBanks(config) {
    try {
        const res = await fetch(`${config.api_url}/v1/default/banks`, {
            headers: { "Authorization": `Bearer ${config.api_key || ""}` }
        });
        if (!res.ok)
            return null;
        const data = await res.json();
        return Array.isArray(data) ? data : (data.banks || []);
    }
    catch (_) {
        return null;
    }
}
async function deleteBank(config, bank) {
    try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${config.api_key || ""}` }
        });
        return res.ok;
    }
    catch (_) {
        return false;
    }
}
function lastBankActivity(bank) {
    for (const value of [bank.last_write_at, bank.last_document_at, bank.created_at]) {
        if (!value)
            continue;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return 0;
}
const hookStats = {
    sessionStart: {},
    recall: {},
    retain: {},
};
function readRecentLogErrors(maxLines = 20) {
    try {
        if (!existsSync(LOG_PATH))
            return [];
        const content = readFileSync(LOG_PATH, "utf-8");
        return content
            .split("\n")
            .filter(l => l.trim())
            .slice(-maxLines);
    }
    catch (_) {
        return [];
    }
}
const OPERATIONAL_TOOLS = [
    "bash", "nu", "process", "read", "write", "edit",
    "grep", "ast_grep_search", "ast_grep_replace", "lsp_navigation"
];
export const GLOBAL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const PROJECT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
export const GLOBAL_RETAIN_MISSION = "Focus on user preferences, communication style, workflow habits, and recurring patterns across projects. Deprioritize one-time events and project-specific implementation details.";
export const GLOBAL_OBSERVATIONS_MISSION = "Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Focus on what the user consistently does or prefers — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations.";
export const PROJECT_RETAIN_MISSION = "Focus on coding conventions, architecture decisions, tech stack choices, project-specific patterns, and user preferences within this codebase. Deprioritize one-time events and transient debugging steps.";
export const PROJECT_OBSERVATIONS_MISSION = "Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Also capture key project context: architecture decisions, tech stack choices, known constraints, and established patterns in the codebase. Focus on what persists across sessions — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations.";
export function getMissionCachePath() {
    return join(homedir(), ".hindsight", "mission-cache.json");
}
export function loadMissionCache() {
    try {
        const path = getMissionCachePath();
        if (!existsSync(path)) {
            return { global: {}, project: {} };
        }
        const data = readFileSync(path, "utf-8");
        return JSON.parse(data);
    }
    catch (_) {
        return { global: {}, project: {} };
    }
}
export function saveMissionCache(cache) {
    try {
        const path = getMissionCachePath();
        mkdirSync(join(homedir(), ".hindsight"), { recursive: true });
        writeFileSync(path, JSON.stringify(cache, null, 2));
    }
    catch (_) { }
}
export function isCacheStale(timestamp, isGlobal) {
    if (!timestamp)
        return true;
    const ttl = isGlobal ? GLOBAL_TTL_SECONDS : PROJECT_TTL_SECONDS;
    return Date.now() / 1000 - timestamp > ttl;
}
export async function setupBankMission(config, bank, isGlobal) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const getRes = await fetch(`${config.api_url}/v1/default/banks/${bank}/config`, {
            headers: { "Authorization": `Bearer ${config.api_key || ""}` },
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (!getRes.ok)
            return;
        const getData = await getRes.json();
        const cfg = getData.config || {};
        if (cfg.retain_mission != null && cfg.observations_mission != null)
            return;
        const retainMission = isGlobal ? GLOBAL_RETAIN_MISSION : PROJECT_RETAIN_MISSION;
        const observationsMission = isGlobal ? GLOBAL_OBSERVATIONS_MISSION : PROJECT_OBSERVATIONS_MISSION;
        const updates = {};
        if (cfg.retain_mission == null)
            updates.retain_mission = retainMission;
        if (cfg.observations_mission == null)
            updates.observations_mission = observationsMission;
        if (Object.keys(updates).length === 0)
            return;
        const patchController = new AbortController();
        const patchTimeout = setTimeout(() => patchController.abort(), 10000);
        const patchRes = await fetch(`${config.api_url}/v1/default/banks/${bank}/config`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.api_key || ""}`
            },
            body: JSON.stringify({ updates }),
            signal: patchController.signal
        });
        clearTimeout(patchTimeout);
        if (patchRes.ok) {
            const cache = loadMissionCache();
            const cacheKey = isGlobal ? "global" : "project";
            if (!cache[cacheKey])
                cache[cacheKey] = {};
            cache[cacheKey][bank] = Math.floor(Date.now() / 1000);
            saveMissionCache(cache);
            log(`setupBankMission: ${bank} updated (global=${isGlobal})`);
        }
    }
    catch (_) { }
}
export async function runMissionAutoSetup(config) {
    if (getBankScope(config) === "session") {
        // Session banks are ephemeral: provisioning missions for each one is a
        // wasted round trip and would create empty banks at session start.
        log("runMissionAutoSetup: skipped (bank_scope=session)");
        return;
    }
    const cache = loadMissionCache();
    const banksToCheck = [];
    if (config.global_bank) {
        banksToCheck.push({ bank: config.global_bank, isGlobal: true });
    }
    const projectBank = getProjectBank(config);
    if (projectBank) {
        banksToCheck.push({ bank: projectBank, isGlobal: false });
    }
    for (const { bank, isGlobal } of banksToCheck) {
        const cacheKey = isGlobal ? "global" : "project";
        const entry = cache[cacheKey]?.[bank];
        if (!isCacheStale(entry, isGlobal))
            continue;
        await setupBankMission(config, bank, isGlobal);
    }
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
const MAX_RECALL_ATTEMPTS = 3;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = [10000, 20000, 40000];
function isRateLimitError(status, body) {
    return status === 429 || body.includes("429") || body.includes("TooManyRequestsError");
}
async function fetchWithRateLimitRetry(url, options, label) {
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
        const res = await fetch(url, options);
        if (res.ok)
            return { res, rateLimitExhausted: false };
        const errorBody = await res.text();
        if (!isRateLimitError(res.status, errorBody)) {
            // Non-rate-limit error — return immediately, caller handles it
            log(`${label}: HTTP ${res.status} - ${errorBody.slice(0, 200)}`);
            return { res, rateLimitExhausted: false };
        }
        if (attempt < RATE_LIMIT_RETRIES) {
            const delay = RATE_LIMIT_BACKOFF_MS[attempt];
            log(`${label}: rate-limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})`);
            await new Promise((r) => setTimeout(r, delay));
        }
        else {
            log(`${label}: rate-limited (429), exhausted ${RATE_LIMIT_RETRIES} retries`);
            return { res, rateLimitExhausted: true };
        }
    }
    // unreachable, but satisfy TS
    throw new Error("unreachable");
}
export default function hindsightExtension(pi) {
    let recallDone = false;
    let recallAttempts = 0;
    let retainSuccessCount = 0;
    let retainEligibleCount = 0;
    let currentPrompt = "";
    let lastRunMessages = [];
    // Track user input for fallback
    pi.on("input", async (event) => {
        if (event.input)
            currentPrompt = event.input;
        else if (event.text)
            currentPrompt = event.text;
    });
    pi.on("session_start", async (_event, ctx) => {
        sessionCwd = ctx.cwd || process.cwd();
        currentSessionId = ctx.sessionManager?.getSessionId?.() ?? null;
        recallDone = false;
        recallAttempts = 0;
        hookStats.sessionStart = { firedAt: new Date().toISOString(), result: "ok" };
        hookStats.recall = {};
        hookStats.retain = {};
        retainSuccessCount = 0;
        retainEligibleCount = 0;
        lastRunMessages = [];
        ctx.ui.setStatus("hindsight", undefined);
        log("session_start: state reset");
        const config = getConfig();
        if (config) {
            log(`session_start: scope=${getBankScope(config)} session=${currentSessionId ?? "unknown"} banks=${getRecallBanks(config).join(",")}`);
            const banks = getRecallBanks(config);
            if (banks.length === 0) {
                ctx.ui.setStatus("hindsight", "⚠ no banks — /hindsight settings to configure");
                ctx.ui.notify("Hindsight has no active banks. Memory recall and retain are disabled.\n" +
                    "\n" +
                    "Fix: run /hindsight settings and set global_bank, or set homedir_project = true.", "warning");
                log("session_start: no active banks — global_bank not set and homedir_project=false in home dir");
            }
            const legacyIssues = detectLegacyKeys();
            if (legacyIssues.length > 0) {
                const keys = legacyIssues.map(i => `${i.key} → ${i.canonical}`).join(", ");
                ctx.ui.setStatus("hindsight", "⚠ outdated config — run /hindsight doctor");
                ctx.ui.notify(`Your config uses deprecated keys: ${keys}\n` +
                    "Run /hindsight doctor to auto-migrate, or update manually.", "warning");
                log(`session_start: legacy keys detected: ${keys}`);
            }
            // Fire-and-forget warm-up ping to wake server before before_agent_start
            if (config.api_url) {
                fetch(`${config.api_url}/health`, {
                    headers: { "Authorization": `Bearer ${config.api_key || ""}` }
                }).then(() => log("session_start: warm-up ping ok"))
                    .catch(() => log("session_start: warm-up ping failed (server may be cold)"));
            }
            // Fire-and-forget mission auto-setup
            runMissionAutoSetup(config).catch(() => { });
        }
    });
    pi.on("session_compact", async (_event, ctx) => {
        sessionCwd = ctx.cwd || process.cwd();
        currentSessionId = ctx.sessionManager?.getSessionId?.() ?? currentSessionId;
        recallDone = false;
        recallAttempts = 0;
        retainSuccessCount = 0;
        retainEligibleCount = 0;
        lastRunMessages = [];
        ctx.ui.setStatus("hindsight", undefined);
        log("session_compact: state reset");
    });
    pi.registerMessageRenderer("hindsight-recall", (message, _options, theme) => {
        const count = message.details?.count ?? 0;
        const snippet = message.details?.snippet ?? "";
        let text = theme.fg("accent", "🧠 Hindsight");
        text += theme.fg("muted", ` recalled ${count} ${count === 1 ? "memory" : "memories"}`);
        if (snippet) {
            text += "\n" + theme.fg("dim", snippet);
        }
        return new Text(text, 0, 0);
    });
    pi.registerMessageRenderer("hindsight-retain", (message, _options, theme) => {
        const banks = message.details?.banks ?? [];
        let text = theme.fg("accent", "💾 Hindsight");
        text += theme.fg("muted", ` saved turn to memory`);
        if (banks.length > 0) {
            text += theme.fg("dim", ` → ${banks.join(", ")}`);
        }
        return new Text(text, 0, 0);
    });
    pi.registerMessageRenderer("hindsight-retain-failed", (_message, _options, theme) => {
        let text = theme.fg("error", "💾 Hindsight");
        text += theme.fg("muted", " retain failed - use ");
        text += theme.fg("accent", "hindsight_retain");
        text += theme.fg("muted", " to save manually");
        return new Text(text, 0, 0);
    });
    // -----------------------------------------------------------------------
    // Explicit Manual Tools (for when the background loop isn't enough)
    // -----------------------------------------------------------------------
    pi.registerTool({
        name: "hindsight_recall",
        label: "Hindsight Recall",
        description: "Recall relevant context, conventions, or past solutions from the team memory. Use this when the user explicitly asks you to search memory.",
        parameters: Type.Object({
            query: Type.String(),
            bank: Type.Optional(Type.String({ description: "Search this exact bank instead of the banks recall reads by default (the current project and the global bank), e.g. another project's bank" }))
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const { query, bank: explicitBank } = params;
            const config = getConfig();
            if (!config || !config.api_url)
                return { content: [{ type: "text", text: "Hindsight not configured." }], details: {}, isError: true };
            const sessionId = ctx?.sessionManager?.getSessionId?.() ?? currentSessionId;
            const banks = explicitBank ? [explicitBank] : getRecallBanks(config, sessionId);
            try {
                const recallPromises = banks.map(async (bank) => {
                    const reqBody = { query, budget: config.recall_budget, query_timestamp: new Date().toISOString(), types: config.recall_types };
                    if (config.recall_max_tokens !== undefined)
                        reqBody.max_tokens = config.recall_max_tokens;
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), config.recall_timeout ?? 10000);
                    try {
                        const { res, rateLimitExhausted } = await fetchWithRateLimitRetry(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${config.api_key || ""}`
                            },
                            body: JSON.stringify(reqBody),
                            signal: controller.signal
                        }, `hindsight_recall: bank=${bank}`);
                        if (rateLimitExhausted)
                            return { __rateLimited: true };
                        if (!res.ok)
                            return [];
                        const data = await res.json();
                        return (data.results || []).map((r) => `[Bank: ${bank}] - ${r.text}`);
                    }
                    catch (e) {
                        log(`hindsight_recall: bank=${bank} error ${e}`);
                        return [];
                    }
                    finally {
                        clearTimeout(timeout);
                    }
                });
                const resultsArrays = await Promise.all(recallPromises);
                if (resultsArrays.some((r) => r?.__rateLimited)) {
                    return { content: [{ type: "text", text: "Recall rate-limited — reranker quota exceeded (Cohere Trial key: 10 calls/min). Upgrade at https://dashboard.cohere.com/api-keys or switch reranker provider on the Hindsight server." }], details: {}, isError: true };
                }
                const allResults = resultsArrays.flat();
                if (allResults.length > 0) {
                    return { content: [{ type: "text", text: allResults.join("\n\n") }], details: {} };
                }
                return { content: [{ type: "text", text: "No memories found." }], details: {} };
            }
            catch (e) {
                return { content: [{ type: "text", text: `Error: ${e}` }], details: {}, isError: true };
            }
        }
    });
    pi.registerTool({
        name: "hindsight_retain",
        label: "Hindsight Retain",
        description: "Force-save an explicit insight to memory. Only use when explicitly requested by the user, as normal conversation is auto-retained.",
        parameters: Type.Object({
            content: Type.String({ description: "The rich context to save" })
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const { content } = params;
            const config = getConfig();
            if (!config || !config.api_url)
                return { content: [{ type: "text", text: "Hindsight not configured." }], details: {}, isError: true };
            const sessionId = ctx?.sessionManager?.getSessionId?.() ?? currentSessionId;
            const isHomeDirNoProject = isHomeDirSession() && config.homedir_project === false;
            const bank = getBankScope(config) === "session"
                ? getSessionBank(config, sessionId)
                : isHomeDirNoProject
                    ? (config.global_bank ?? null)
                    : getProjectBank(config);
            if (!bank)
                return { content: [{ type: "text", text: "Hindsight: no bank available. Set global_bank in ~/.hindsight/config." }], details: {}, isError: true };
            try {
                const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${config.api_key || ""}`
                    },
                    body: JSON.stringify({ items: [{ content, context: "pi coding session: explicit user save", timestamp: new Date().toISOString() }], async: false })
                });
                if (res.ok)
                    return { content: [{ type: "text", text: "Memory explicitly retained." }], details: {} };
                return { content: [{ type: "text", text: "Failed to retain memory." }], details: {}, isError: true };
            }
            catch (e) {
                return { content: [{ type: "text", text: `Error: ${e}` }], details: {}, isError: true };
            }
        }
    });
    pi.registerTool({
        name: "hindsight_reflect",
        label: "Hindsight Reflect",
        description: "Synthesize context from memory to answer a question.",
        parameters: Type.Object({
            query: Type.String()
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const { query } = params;
            const config = getConfig();
            if (!config || !config.api_url)
                return { content: [{ type: "text", text: "Hindsight not configured." }], details: {}, isError: true };
            const sessionId = ctx?.sessionManager?.getSessionId?.() ?? currentSessionId;
            const bank = getBankScope(config) === "session"
                ? getSessionBank(config, sessionId)
                : getProjectBank(config);
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), config.recall_timeout ?? 10000);
                const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/reflect`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${config.api_key || ""}`
                    },
                    body: JSON.stringify({ query }),
                    signal: controller.signal
                });
                clearTimeout(timeout);
                if (res.ok) {
                    const data = await res.json();
                    return { content: [{ type: "text", text: data.text || JSON.stringify(data) }], details: {} };
                }
                return { content: [{ type: "text", text: `Failed to reflect (HTTP ${res.status}).` }], details: {}, isError: true };
            }
            catch (e) {
                return { content: [{ type: "text", text: `Error: ${e}` }], details: {}, isError: true };
            }
        }
    });
    // -----------------------------------------------------------------------
    pi.on("before_agent_start", async (_event, ctx) => {
        if (recallDone) {
            log("before_agent_start: skip (recallDone=true)");
            return;
        }
        if (recallAttempts >= MAX_RECALL_ATTEMPTS) {
            log(`before_agent_start: skip (max attempts ${MAX_RECALL_ATTEMPTS} reached)`);
            return;
        }
        recallAttempts++;
        log(`before_agent_start: attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS}`);
        const config = getConfig();
        if (!config || !config.api_url) {
            log("before_agent_start: no config, giving up");
            recallAttempts = MAX_RECALL_ATTEMPTS; // don't retry - config won't change mid-session
            ctx.ui.setStatus("hindsight", "⚠ not configured");
            return;
        }
        if (config.recall_enabled === false) {
            log("before_agent_start: recall disabled by config");
            recallDone = true;
            return;
        }
        const lastUserPrompt = getLastUserMessage(ctx, currentPrompt) || "Provide context for current project";
        const banks = getRecallBanks(config, ctx.sessionManager?.getSessionId?.() ?? currentSessionId);
        log(`before_agent_start: querying banks=${banks.join(",")} prompt="${lastUserPrompt.slice(0, 80)}"`);
        try {
            let anyBankSucceeded = false;
            let anyBankMissing = false;
            let anyBankFailed = false;
            let authFailed = false;
            let rateLimitedFailed = false;
            const recallPromises = banks.map(async (bank) => {
                const reqBody = { query: lastUserPrompt, budget: config.recall_budget, query_timestamp: new Date().toISOString(), types: config.recall_types };
                if (config.recall_max_tokens !== undefined)
                    reqBody.max_tokens = config.recall_max_tokens;
                const controller = new AbortController();
                const timeout = setTimeout(() => {
                    controller.abort();
                    log(`before_agent_start: bank=${bank} timed out`);
                }, config.recall_timeout ?? 10000);
                try {
                    const { res, rateLimitExhausted } = await fetchWithRateLimitRetry(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${config.api_key || ""}`
                        },
                        body: JSON.stringify(reqBody),
                        signal: controller.signal
                    }, `before_agent_start: bank=${bank}`);
                    if (rateLimitExhausted) {
                        rateLimitedFailed = true;
                        return [];
                    }
                    if (res.status === 404) {
                        // A session bank is created by the first retain. Before that, the
                        // bank does not exist — that is an empty vault, not a failure, and
                        // not a completed recall either: retry once the first retain has
                        // created it.
                        anyBankMissing = true;
                        log(`before_agent_start: bank=${bank} does not exist yet (waiting for first retain)`);
                        return [];
                    }
                    if (!res.ok) {
                        anyBankFailed = true;
                        if (res.status === 401 || res.status === 403)
                            authFailed = true;
                        return [];
                    }
                    anyBankSucceeded = true;
                    const data = await res.json();
                    const results = (data.results || []).map((r) => `[Bank: ${bank}] - ${r.text}`);
                    log(`before_agent_start: bank=${bank} got ${results.length} results`);
                    return results;
                }
                catch (e) {
                    anyBankFailed = true;
                    log(`before_agent_start: bank=${bank} error ${e}`);
                    return [];
                }
                finally {
                    clearTimeout(timeout);
                }
            });
            const resultsArrays = await Promise.all(recallPromises);
            if (authFailed) {
                hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "auth error" };
                recallAttempts = MAX_RECALL_ATTEMPTS; // auth won't fix itself mid-session
                ctx.ui.setStatus("hindsight", "✗ auth error - check api_key");
                log("before_agent_start: auth error, giving up");
                return;
            }
            if (rateLimitedFailed) {
                hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "rate limited" };
                recallAttempts = MAX_RECALL_ATTEMPTS;
                ctx.ui.setStatus("hindsight", "✗ rate-limited (reranker quota exceeded)");
                log("before_agent_start: rate-limited, giving up");
                return;
            }
            if (anyBankSucceeded) {
                recallDone = true;
                ctx.ui.setStatus("hindsight", undefined);
                const allResults = resultsArrays.flat();
                if (allResults.length > 0) {
                    hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: `${allResults.length} memories` };
                    log(`before_agent_start: injecting ${allResults.length} memories into context`);
                    const memoriesStr = allResults.join("\n\n");
                    const content = `<hindsight_memories>\nRelevant memories from past conversations:\n\n${memoriesStr}\n</hindsight_memories>`;
                    const count = allResults.length;
                    const snippet = allResults
                        .slice(0, 3)
                        .map((r) => r.replace(/^\[Bank: [^\]]+\] - /, ""))
                        .join(" \u00b7 ")
                        .slice(0, 200);
                    return {
                        message: {
                            customType: "hindsight-recall",
                            content,
                            display: true,
                            details: { count, snippet }
                        }
                    };
                }
                else {
                    hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: "vault empty" };
                    log("before_agent_start: no memories found (empty vault)");
                }
            }
            else if (anyBankMissing && !anyBankFailed) {
                // A not-yet-created bank is not a failed recall attempt: do not let it
                // consume the retry budget before the first retain has created it.
                recallAttempts = Math.max(0, recallAttempts - 1);
                hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: "bank not created yet" };
                ctx.ui.setStatus("hindsight", undefined);
                log("before_agent_start: bank not created yet, will retry after the first retain");
            }
            else {
                const isLastAttempt = recallAttempts >= MAX_RECALL_ATTEMPTS;
                hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: isLastAttempt ? "unreachable" : "retrying" };
                ctx.ui.setStatus("hindsight", isLastAttempt ? "✗ recall unavailable" : "⚠ recall failed (retrying)");
                log(`before_agent_start: all banks failed, will retry (attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS})`);
            }
        }
        catch (e) {
            const isLastAttempt = recallAttempts >= MAX_RECALL_ATTEMPTS;
            ctx.ui.setStatus("hindsight", isLastAttempt ? "✗ recall unavailable" : "⚠ recall failed (retrying)");
            log(`before_agent_start: error ${e}, will retry (attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS})`);
        }
    });
    // -----------------------------------------------------------------------
    // Auto-Retain (agent_settled)
    // -----------------------------------------------------------------------
    // `agent_end` closes one low-level run; retries, overflow recovery, compaction
    // retry, steering, and queued follow-ups can still continue it, so retaining
    // there can capture half a conversation and can fire twice for one settle.
    // Stash the run's messages on agent_end and do the work once Pi has no
    // automatic continuation left.
    pi.on("agent_end", async (event) => {
        lastRunMessages = event.messages || [];
    });
    // The pinned dev types (@mariozechner/pi-coding-agent 0.66) predate
    // `agent_settled`; the running pi (1.4+) emits it. Runtime alias maps both
    // package names onto the same module, so only the build-time type needs a cast.
    pi.on("agent_settled", async (event, ctx) => {
        log("agent_settled: fired");
        const config = getConfig();
        if (!config || !config.api_url) {
            log("agent_settled: no config, skipping");
            return;
        }
        if (config.retain_enabled === false) {
            log("agent_settled: retain disabled by config");
            return;
        }
        const lastUserPrompt = getLastUserMessage(ctx, currentPrompt);
        const sessionId = ctx.sessionManager?.getSessionId?.() || currentSessionId;
        if (!lastUserPrompt) {
            log("agent_settled: no user prompt found, skipping");
            return;
        }
        // Skip trivial interactions
        if (lastUserPrompt.length < 5 || /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i.test(lastUserPrompt.trim())) {
            log(`agent_settled: trivial prompt, skipping retain`);
            return;
        }
        // Opt-out mechanism
        if (lastUserPrompt.trim().startsWith("#nomem") || lastUserPrompt.trim().startsWith("#skip")) {
            log("agent_settled: opt-out tag, skipping retain");
            return;
        }
        let transcript = `[role: user]\n${lastUserPrompt}\n[user:end]\n\n[role: assistant]\n`;
        const messages = lastRunMessages;
        if (!messages.some((msg) => msg.role === "assistant")) {
            log("agent_settled: no assistant output in the run, skipping retain");
            return;
        }
        for (const msg of messages) {
            if (msg.role !== "assistant")
                continue;
            const content = msg.content;
            if (typeof content === "string") {
                transcript += `${content}\n`;
            }
            else if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text") {
                        transcript += `${block.text}\n`;
                    }
                    else if (block.type === "tool_use") {
                        if (!OPERATIONAL_TOOLS.includes(block.name)) {
                            transcript += `[Tool Use: ${block.name}]\n`;
                            if (block.input) {
                                transcript += `${JSON.stringify(block.input)}\n`;
                            }
                        }
                    }
                }
            }
        }
        transcript += `[assistant:end]`;
        // Extract explicit #tags from the user prompt (ignoring our reserved control tags)
        const reservedTags = new Set(["nomem", "skip", "global", "me"]);
        const extractedTags = Array.from(lastUserPrompt.matchAll(/(?<=^|\s)#([a-zA-Z0-9_-]+)/g))
            .map(match => match[1].toLowerCase())
            .filter(tag => !reservedTags.has(tag));
        // Strip memory tags to prevent feedback loop
        transcript = transcript.replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "");
        transcript = transcript.trim();
        if (transcript.length < 20)
            return;
        // Hard-cap massive transcripts (e.g. agent printing full file out) to avoid bombing server
        if (transcript.length > 50000) {
            transcript = transcript.slice(0, 50000) + "\n...[TRUNCATED]";
        }
        const banks = getRetainBanks(config, lastUserPrompt, sessionId);
        if (banks.length === 0) {
            log("agent_settled: no retain banks, skipping");
            return;
        }
        // Count this attempt (before the retain APIs)
        retainEligibleCount++;
        // Async retain: fire and forget, don't block
        if (config.async_retain !== false) {
            log("agent_settled: async retain fired (not awaiting)");
            const retainPromise = Promise.allSettled(banks.map(async (bank) => {
                const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${config.api_key || ""}`
                    },
                    body: JSON.stringify({
                        items: [{
                                content: transcript,
                                document_id: `session-${sessionId ?? "unknown"}`,
                                update_mode: "append",
                                context: `pi coding session: ${lastUserPrompt.slice(0, 100)}`,
                                timestamp: new Date().toISOString(),
                                ...(extractedTags.length > 0 && { tags: extractedTags })
                            }],
                        async: true
                    })
                });
                log(`agent_settled: bank=${bank} retain HTTP ${res.status}`);
                if (!res.ok)
                    throw new Error(`HTTP ${res.status}`);
                return bank;
            }));
            retainPromise.then((results) => {
                const succeededBanks = results
                    .filter(r => r.status === "fulfilled")
                    .map(r => r.value);
                const allFailed = succeededBanks.length === 0;
                hookStats.retain = {
                    firedAt: new Date().toISOString(),
                    result: allFailed ? "failed" : "ok",
                    detail: allFailed ? "all banks unreachable" : succeededBanks.join(", "),
                };
                if (!allFailed)
                    retainSuccessCount++;
                if (allFailed) {
                    log("agent_settled: async retain - all banks failed");
                }
                else {
                    log(`agent_settled: async retain - succeeded banks=${succeededBanks.join(",")}`);
                }
                emitRetainReport(pi, ctx, {
                    succeededBanks,
                    allFailed,
                    sessionId,
                    retainSuccessCount,
                    retainEligibleCount,
                });
            });
            return;
        }
        // Sync retain (original behavior)
        try {
            log(`agent_settled: retaining to banks=${banks.join(",")} transcript_len=${transcript.length} tags=${extractedTags.join(",")}`);
            const results = await Promise.allSettled(banks.map(async (bank) => {
                const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${config.api_key || ""}`
                    },
                    body: JSON.stringify({
                        items: [{
                                content: transcript,
                                document_id: `session-${sessionId ?? "unknown"}`,
                                update_mode: "append",
                                context: `pi coding session: ${lastUserPrompt.slice(0, 100)}`,
                                timestamp: new Date().toISOString(),
                                ...(extractedTags.length > 0 && { tags: extractedTags })
                            }],
                        async: true
                    })
                });
                log(`agent_settled: bank=${bank} retain HTTP ${res.status}`);
                if (!res.ok)
                    throw new Error(`HTTP ${res.status}`);
                return bank;
            }));
            const succeededBanks = results
                .filter(r => r.status === "fulfilled")
                .map(r => r.value);
            const allFailed = succeededBanks.length === 0;
            hookStats.retain = {
                firedAt: new Date().toISOString(),
                result: allFailed ? "failed" : "ok",
                detail: allFailed ? "all banks unreachable" : succeededBanks.join(", "),
            };
            if (!allFailed)
                retainSuccessCount++;
            if (allFailed) {
                log("agent_settled: all banks failed - sending next-turn notification");
            }
            emitRetainReport(pi, ctx, {
                succeededBanks,
                allFailed,
                sessionId,
                retainSuccessCount,
                retainEligibleCount,
            });
        }
        catch (e) {
            log(`agent_settled: error ${e}`);
        }
    });
    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------
    pi.registerCommand("hindsight", {
        description: "Hindsight memory. Usage: /hindsight [status | stats | settings | doctor | prune]",
        handler: async (args, ctx) => {
            const config = getConfig();
            if (!config) {
                ctx.ui.notify("Hindsight config not found. Create ~/.hindsight/config", "error");
                return;
            }
            const argsStr = (typeof args === "string" ? args : "").trim();
            if (argsStr === "status") {
                const lines = [];
                let hasError = false;
                // Config
                lines.push(`URL:    ${config.api_url || "Not set"}`);
                if (!config.api_url) {
                    lines.push("  ✗ api_url missing");
                    hasError = true;
                }
                if (!config.api_key) {
                    lines.push("  ⚠ api_key not set");
                }
                // Server health
                const health = await getServerHealth(config);
                lines.push(`Server: ${health.ok ? "✓ online" : `✗ unreachable${health.status ? ` (HTTP ${health.status})` : ""}`}`);
                if (!health.ok)
                    hasError = true;
                // Bank: auth + mission
                const scope = getBankScope(config);
                const sessionId = ctx.sessionManager?.getSessionId?.() ?? currentSessionId;
                const bank = scope === "session" ? getSessionBank(config, sessionId) : getProjectBank(config);
                lines.push(`Scope:  ${scope}${scope === "session" ? ` (session ${sessionId ?? "unknown"})` : ""}`);
                lines.push(`Bank:   ${bank}`);
                const bankCheck = await checkBankConfig(config, bank);
                if (!bankCheck.ok) {
                    lines.push(`  ✗ ${bankCheck.authError ? "auth invalid - check api_key" : "bank unreachable"}`);
                    hasError = true;
                }
                else if (bankCheck.missing) {
                    lines.push(`  ✓ auth ok (bank created on first retain)`);
                }
                else {
                    lines.push(`  ✓ auth ok`);
                }
                if (config.global_bank)
                    lines.push(`Global: ${config.global_bank}`);
                if (scope === "session") {
                    lines.push(`Project: ${getProjectBank(config)} (used only with bank_scope=project)`);
                }
                // Hook state
                lines.push("");
                lines.push("Hooks this session:");
                const hookIcon = (r) => r === "ok" ? "✓" : r === "failed" ? "✗" : r === "skipped" ? "-" : "...";
                const fmtHook = (h) => h.firedAt ? `${hookIcon(h.result)} ${h.result}${h.detail ? ` (${h.detail})` : ""}` : "not fired";
                lines.push(`  session_start:      ${fmtHook(hookStats.sessionStart)}`);
                lines.push(`  recall:             ${fmtHook(hookStats.recall)}`);
                lines.push(`  retain:             ${fmtHook(hookStats.retain)}`);
                // Debug log
                lines.push("");
                if (DEBUG) {
                    const logLines = readRecentLogErrors(10);
                    lines.push(`Debug log (last ${logLines.length} lines):`);
                    logLines.forEach(l => lines.push(`  ${l}`));
                }
                else {
                    lines.push("Debug log: disabled (set HINDSIGHT_DEBUG=1 to enable)");
                }
                ctx.ui.notify(lines.join("\n"), hasError ? "error" : "info");
                return;
            }
            if (argsStr === "stats") {
                const banks = getRecallBanks(config, ctx.sessionManager?.getSessionId?.() ?? currentSessionId);
                const allStats = await Promise.all(banks.map(async (bank) => {
                    const stats = await getBankStats(config, bank);
                    return { bank, stats };
                }));
                const lines = allStats.map(({ bank, stats }) => {
                    if (!stats)
                        return `${bank}: unavailable`;
                    const entries = Object.entries(stats)
                        .map(([k, v]) => `  ${k}: ${v}`)
                        .join("\n");
                    return `${bank}:\n${entries}`;
                });
                ctx.ui.notify(lines.join("\n\n"), "info");
                return;
            }
            if (argsStr === "settings") {
                const globalCfgPath = join(homedir(), ".hindsight", "config");
                const localCfgPath = join(sessionCwd, ".hindsight", "config");
                let cfg = getConfigWithSource();
                const isHomeDir = cfg.isHomeDir;
                const settingsMeta = [
                    { key: "api_url", label: "API URL", isBool: false, default: "(required)" },
                    { key: "api_key", label: "API Key", isBool: false, default: "(required)" },
                    { key: "global_bank", label: "Global Bank", isBool: false, default: "(not set)" },
                    { key: "bank_scope", label: "Bank Scope (project|session)", isBool: false, default: "project" },
                    { key: "bank_namespace", label: "Bank Namespace", isBool: false, default: "(hostname)" },
                    { key: "session_bank_ttl_days", label: "Session Bank TTL (days)", isBool: false, default: "30" },
                    { key: "project_bank_id", label: "Project Bank Override", isBool: false, default: "(auto)" },
                    { key: "recall_enabled", label: "Auto-Recall", isBool: true, default: "true" },
                    { key: "retain_enabled", label: "Auto-Retain", isBool: true, default: "true" },
                    { key: "async_retain", label: "Async Retain", isBool: true, default: "true" },
                    { key: "retain_feedback", label: "Retain Feedback", isBool: false, default: "status" },
                    { key: "homedir_project", label: "Home Dir as Project", isBool: true, default: "true" },
                    { key: "recall_types", label: "Recall Types", isBool: false, default: "observation" },
                    { key: "recall_budget", label: "Recall Budget", isBool: false, default: "mid" },
                    { key: "recall_max_tokens", label: "Max Tokens", isBool: false, default: "(default)" },
                    { key: "recall_timeout", label: "Recall Timeout (ms)", isBool: false, default: "10000" },
                ];
                const DONE_LABEL = "← Done";
                const buildOptions = () => {
                    const options = [];
                    if (isHomeDir)
                        options.push("⚠ CWD is home dir - all saves go to global config");
                    for (const s of settingsMeta) {
                        const val = cfg.merged[s.key] ?? s.default;
                        const src = cfg.local[s.key] !== undefined ? "project" : cfg.global[s.key] !== undefined ? "global" : "default";
                        options.push(`${s.label}: ${s.key === "api_key" && val !== s.default ? "****" : val} [${src}]`);
                    }
                    options.push(DONE_LABEL);
                    return options;
                };
                while (true) {
                    const options = buildOptions();
                    const choice = await ctx.ui.select("Hindsight Settings", options);
                    if (!choice || choice === DONE_LABEL || choice.startsWith("⚠")) {
                        if (choice?.startsWith("⚠"))
                            continue;
                        break;
                    }
                    // Find which setting was picked
                    const selected = settingsMeta.find(s => choice.startsWith(s.label + ":"));
                    if (!selected)
                        continue;
                    const currentVal = cfg.merged[selected.key];
                    let newValue;
                    if (selected.isBool) {
                        // Toggle boolean
                        const curBool = currentVal !== "false";
                        const toggleChoice = await ctx.ui.select(`${selected.label} (currently ${curBool ? "on" : "off"})`, ["On", "Off", "← Cancel"]);
                        if (!toggleChoice || toggleChoice === "← Cancel")
                            continue;
                        newValue = toggleChoice === "On" ? "true" : "false";
                    }
                    else {
                        // Text input
                        const inputVal = await ctx.ui.input(`${selected.label}:`, currentVal || "");
                        if (inputVal === undefined || inputVal === "")
                            continue;
                        newValue = inputVal;
                    }
                    // Determine save target
                    let saveGlobal = true;
                    let saveLocal = false;
                    if (!isHomeDir) {
                        const target = await ctx.ui.select(`Save ${selected.label} to:`, ["Project (.hindsight/config)", "Global (~/.hindsight/config)", "← Cancel"]);
                        if (!target || target === "← Cancel")
                            continue;
                        saveGlobal = target.startsWith("Global");
                        saveLocal = target.startsWith("Project");
                    }
                    if (saveGlobal)
                        writeConfigValue(globalCfgPath, selected.key, newValue);
                    if (saveLocal)
                        writeConfigValue(localCfgPath, selected.key, newValue);
                    // Refresh merged view
                    cfg = getConfigWithSource();
                    ctx.ui.notify(`${selected.label} → ${selected.key === "api_key" ? "****" : newValue}`, "info");
                }
                return;
            }
            if (argsStr === "doctor") {
                const issues = detectLegacyKeys();
                if (issues.length === 0) {
                    ctx.ui.notify("No issues found. Config is up to date.", "info");
                    return;
                }
                const summary = issues.map(i => `  ${i.key} \u2192 ${i.canonical} in ${i.file}`).join("\n");
                ctx.ui.notify(`Legacy config keys found:\n${summary}`, "warning");
                const ok = await ctx.ui.confirm("Migrate config?", `This will rename legacy keys in your config file(s). The old values are preserved, only the key names change.`);
                if (!ok) {
                    ctx.ui.notify("Migration skipped. You can edit config files manually.", "info");
                    return;
                }
                const migrated = [];
                const seen = new Set();
                for (const issue of issues) {
                    if (seen.has(issue.file))
                        continue;
                    seen.add(issue.file);
                    const result = migrateConfigFile(issue.file);
                    migrated.push(...result.map(r => `${r} in ${issue.file}`));
                }
                if (migrated.length > 0) {
                    ctx.ui.setStatus("hindsight", undefined);
                    ctx.ui.notify(`Migrated:\n  ${migrated.join("\n  ")}`, "info");
                }
                else {
                    ctx.ui.notify("Nothing to migrate.", "info");
                }
                return;
            }
            if (argsStr === "prune" || argsStr.startsWith("prune ")) {
                const parts = argsStr.split(/\s+/).slice(1);
                const daysArg = parts.find(p => /^\d+$/.test(p));
                const days = daysArg ? parseInt(daysArg, 10) : (config.session_bank_ttl_days ?? 30);
                const confirmed = parts.includes("--yes");
                const prefix = getSessionBankPrefix(config);
                if (!prefix) {
                    ctx.ui.notify("Refusing to prune: session banks cannot be identified safely without bank_namespace or project_bank_id.", "error");
                    return;
                }
                const all = await listBanks(config);
                if (!all) {
                    ctx.ui.notify("Could not list banks from the server.", "error");
                    return;
                }
                const protectedBanks = new Set([
                    config.global_bank,
                    getProjectBank(config),
                    getSessionBank(config, ctx.sessionManager?.getSessionId?.() ?? currentSessionId),
                ].filter(Boolean));
                const cutoff = Date.now() - days * 86400000;
                const candidates = all.filter((b) => b.bank_id.startsWith(prefix) &&
                    !protectedBanks.has(b.bank_id) &&
                    lastBankActivity(b) > 0 &&
                    lastBankActivity(b) < cutoff);
                if (candidates.length === 0) {
                    ctx.ui.notify(`No session banks idle for more than ${days} day(s).`, "info");
                    return;
                }
                const listing = candidates
                    .map(b => `  ${b.bank_id} (${b.fact_count ?? "?"} facts, last write ${b.last_write_at?.slice(0, 10) ?? "unknown"})`)
                    .join("\n");
                if (!confirmed) {
                    ctx.ui.notify(`${candidates.length} session bank(s) idle for ${days}+ day(s):\n${listing}\n\nNothing deleted. Re-run with --yes to delete.`, "warning");
                    return;
                }
                let deleted = 0;
                for (const b of candidates) {
                    if (await deleteBank(config, b.bank_id))
                        deleted++;
                }
                ctx.ui.notify(`Deleted ${deleted}/${candidates.length} session bank(s):\n${listing}`, deleted === candidates.length ? "info" : "warning");
                return;
            }
            const status = [
                `URL: ${config.api_url || "Not set"}`,
                `Global Bank: ${config.global_bank || "Not set"}`,
                `Bank Scope: ${getBankScope(config)}`,
                `Active Bank: ${getBankScope(config) === "session" ? getSessionBank(config, ctx.sessionManager?.getSessionId?.() ?? currentSessionId) : getProjectBank(config)}`,
                `Project Bank: ${getProjectBank(config)}`,
                `Active Recall Banks: ${getRecallBanks(config, ctx.sessionManager?.getSessionId?.() ?? currentSessionId).join(", ")}`,
                `Commands: /hindsight status | stats | settings | doctor | prune`,
            ].join("\n");
            ctx.ui.notify(status, "info");
        },
    });
}
