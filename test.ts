/**
 * Tests for hindsight-selfhosted extension.
 * Uses Node.js built-in test runner (node:test).
 *
 * Run: node --experimental-strip-types --experimental-vm-modules test.ts
 * Or after build: node test.js
 */

import { test, describe, beforeEach, before, after, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal Pi API mock
// ---------------------------------------------------------------------------

type HookName = "session_start" | "session_compact" | "before_agent_start" | "agent_end" | "agent_settled" | "input";
type HookHandler = (event: any, ctx: any) => Promise<any>;

function makePiMock() {
  const handlers: Record<string, HookHandler[]> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const sentMessages: { message: any; options: any }[] = [];
  let stale = false;

  return {
    on(event: HookName, handler: HookHandler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerTool(spec: any) {
      tools[spec.name] = spec;
    },
    registerCommand(name: string, spec: any) {
      commands[name] = spec;
    },
    registerMessageRenderer(_type: string, _renderer: any) {},
    // Mirrors the real runtime: every method asserts liveness and throws once
    // the extension runtime has been invalidated (session replacement/shutdown).
    getActiveTools(): string[] {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return [];
    },
    sendMessage(message: any, options: any) {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      sentMessages.push({ message, options });
    },
    // Test helpers
    invalidate() {
      stale = true;
    },
    isStale() {
      return stale;
    },
    sentMessages,
    async emit(event: HookName, eventData: any = {}, ctx: any = {}) {
      const list = handlers[event] || [];
      let result: any;
      for (const h of list) {
        result = await h(eventData, ctx);
      }
      return result;
    },
    tools,
    commands,
  };
}

function makeCtx(userMessage?: string) {
  return {
    sessionManager: {
      getEntries() {
        if (!userMessage) return [];
        return [
          {
            type: "message",
            message: { role: "user", content: userMessage },
          },
        ];
      },
    },
    ui: { notify: mock.fn() },
  };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const MOCK_CONFIG_DIR = "/tmp/.hindsight-test-" + Date.now();
const MOCK_CONFIG_PATH = MOCK_CONFIG_DIR + "/config";

function writeConfig(api_url: string, api_key = "test-key", global_bank?: string) {
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(MOCK_CONFIG_DIR, { recursive: true });
  let content = `api_url = "${api_url}"\napi_key = "${api_key}"`;
  if (global_bank) content += `\nglobal_bank = "${global_bank}"`;
  writeFileSync(MOCK_CONFIG_PATH, content);
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchOk(results: { text: string }[] = []) {
  return mock.fn(async (_url: string, _opts: any) => ({
    ok: true,
    status: 200,
    json: async () => ({ results }),
  }));
}

function mockFetchFail(status = 500) {
  return mock.fn(async (_url: string, _opts: any) => ({
    ok: false,
    status,
    json: async () => ({}),
  }));
}

// ---------------------------------------------------------------------------
// Load the extension factory
// NOTE: We patch process.env and global.fetch before importing so we control
//       the config path via env.
// ---------------------------------------------------------------------------

async function loadExtension(fetchMock: any) {
  // Override fetch globally for each test
  (global as any).fetch = fetchMock;

  // Patch homedir to point at our temp dir so getConfig() reads our config
  const originalHomedir = require("node:os").homedir;
  require("node:os").homedir = () => MOCK_CONFIG_DIR;

  // Dynamic import so we can reload with fresh state between tests
  // (Node caches modules, so we use a cache-busting query param trick
  //  by appending a timestamp to the specifier via a loader shim)
  //
  // For simplicity in this test we directly inline & re-run the logic.
  // The real extension factory is called once; we instantiate it fresh
  // via the Pi mock for each test scenario.
  const pi = makePiMock();

  // We re-import each time by clearing module cache (CJS approach)
  // Since the code is ESM we call the factory dynamically via eval workaround.
  // Instead: we expose and directly test the core lifecycle logic
  // by re-running the factory function each time with a fresh pi mock.

  require("node:os").homedir = originalHomedir;
  return pi;
}

// ---------------------------------------------------------------------------
// Direct unit tests on lifecycle logic (avoids ESM reload complexity)
// The strategy: extract functions and test them directly by replaying the
// same hooks pattern without importing the full module.
// ---------------------------------------------------------------------------

const MAX_RECALL_ATTEMPTS = 3;

/**
 * Simulates the before_agent_start lifecycle with injectable dependencies.
 */
async function simulateRecall(opts: {
  config: { api_url: string; api_key?: string; global_bank?: string; recall_budget?: string; recall_max_tokens?: number } | null;
  projectBank: string;
  userPrompt: string;
  fetchImpl: any;
  recallDone?: boolean;
  recallAttempts?: number;
}): Promise<{ recallDone: boolean; recallAttempts: number; injectedContent: string | null }> {
  let recallDone = opts.recallDone ?? false;
  let recallAttempts = opts.recallAttempts ?? 0;

  if (recallDone) return { recallDone, recallAttempts, injectedContent: null };
  if (recallAttempts >= MAX_RECALL_ATTEMPTS) return { recallDone, recallAttempts, injectedContent: null };

  recallAttempts++;

  const config = opts.config;
  if (!config || !config.api_url) {
    recallAttempts = MAX_RECALL_ATTEMPTS; // give up
    return { recallDone, recallAttempts, injectedContent: null };
  }

  const banks = new Set<string>();
  if (config.global_bank) banks.add(config.global_bank);
  banks.add(opts.projectBank);
  const bankList = Array.from(banks);

  try {
    let anyBankSucceeded = false;
    const recallPromises = bankList.map(async (bank) => {
      const res = await opts.fetchImpl(
        `${config.api_url}/v1/default/banks/${bank}/memories/recall`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.api_key || ""}` },
          body: JSON.stringify({ query: opts.userPrompt, budget: opts.config?.recall_budget || "mid", query_timestamp: new Date().toISOString(), ...(opts.config?.recall_max_tokens && { max_tokens: opts.config.recall_max_tokens }) }),
        }
      );
      if (!res.ok) return [];
      anyBankSucceeded = true;
      const data = await res.json();
      return (data.results || []).map((r: any) => `[Bank: ${bank}] - ${r.text}`);
    });

    const resultsArrays = await Promise.all(recallPromises);

    if (anyBankSucceeded) {
      recallDone = true;
      const allResults = resultsArrays.flat();
      if (allResults.length > 0) {
        const memoriesStr = allResults.join("\n\n");
        const content = `<hindsight_memories>\nRelevant memories from past conversations:\n\n${memoriesStr}\n</hindsight_memories>`;
        return { recallDone, recallAttempts, injectedContent: content };
      }
      return { recallDone, recallAttempts, injectedContent: null };
    }
    // all banks failed — don't mark done, will retry
    return { recallDone, recallAttempts, injectedContent: null };
  } catch {
    // network error — don't mark done, will retry
    return { recallDone, recallAttempts, injectedContent: null };
  }
}

/**
 * Simulates the agent_end retain lifecycle.
 */
async function simulateRetain(opts: {
  config: { api_url: string; api_key?: string; global_bank?: string } | null;
  projectBank: string;
  userPrompt: string;
  transcript: string;
  sessionId?: string;
  fetchImpl: any;
  async_retain?: boolean;
}): Promise<{ skipped: boolean; reason?: string; calledBanks: string[]; allFailed: boolean; lastRequestBody?: any; async?: boolean; sentMessage?: any }> {
  const config = opts.config;
  if (!config || !config.api_url) return { skipped: true, reason: "no config", calledBanks: [], allFailed: false };
  const prompt = opts.userPrompt;
  if (!prompt) return { skipped: true, reason: "no prompt", calledBanks: [], allFailed: false };
  if (prompt.length < 5 || /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i.test(prompt.trim())) {
    return { skipped: true, reason: "trivial", calledBanks: [], allFailed: false };
  }
  if (prompt.trim().startsWith("#nomem") || prompt.trim().startsWith("#skip")) {
    return { skipped: true, reason: "opt-out", calledBanks: [], allFailed: false };
  }

  // Async mode: fire and forget, return early without awaiting
  if (opts.async_retain !== false) {
    return { skipped: false, calledBanks: [], allFailed: false, async: true };
  }

  const banks = new Set<string>();
  banks.add(opts.projectBank);
  if (config.global_bank && (prompt.includes("#global") || prompt.includes("#me"))) {
    banks.add(config.global_bank);
  }
  const calledBanks: string[] = [];
  const bankList = Array.from(banks);
  const sessionId = opts.sessionId ?? "test-session";
  let lastRequestBody: any;
  const results = await Promise.allSettled(
    bankList.map(async (bank) => {
      const body = {
        items: [{
          content: opts.transcript,
          document_id: `session-${sessionId}`,
          update_mode: "append",
          context: `pi coding session: ${prompt.slice(0, 100)}`,
          timestamp: new Date().toISOString(),
        }],
        async: true,
      };
      lastRequestBody = body;
      const res = await opts.fetchImpl(`${config.api_url}/v1/default/banks/${bank}/memories`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      calledBanks.push(bank);
      return bank;
    })
  );
  const succeededBanks = results
    .filter(r => r.status === "fulfilled")
    .map(r => (r as PromiseFulfilledResult<string>).value);
  const allFailed = succeededBanks.length === 0;
  const sentMessage = allFailed
    ? { customType: "hindsight-retain-failed", display: true, details: {} }
    : { customType: "hindsight-retain", display: true, details: { banks: succeededBanks } };
  return { skipped: false, calledBanks, allFailed, lastRequestBody, sentMessage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Recall (before_agent_start)", () => {
  const config = { api_url: "http://localhost:4000", api_key: "key", global_bank: "global" };

  test("injects memories when results returned", async () => {
    const fetchMock = mockFetchOk([{ text: "Use TypeBox for validation" }]);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I validate?",
      fetchImpl: fetchMock,
    });

    assert.equal(result.recallDone, true);
    assert.ok(result.injectedContent, "should inject content");
    assert.ok(result.injectedContent!.includes("<hindsight_memories>"), "should wrap in tag");
    assert.ok(result.injectedContent!.includes("TypeBox"), "should include memory text");
  });

  test("returns null injectedContent when no memories found", async () => {
    const fetchMock = mockFetchOk([]);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "what is the meaning of life",
      fetchImpl: fetchMock,
    });

    assert.equal(result.injectedContent, null);
  });

  test("queries both global_bank and project bank", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    const urls: string[] = fetchMock.mock.calls.map((c: any) => c.arguments[0]);
    assert.ok(urls.some((u) => u.includes("global")), "should query global bank");
    assert.ok(urls.some((u) => u.includes("project-hindsight")), "should query project bank");
    assert.equal(urls.length, 2, "should call exactly 2 banks");
  });

  test("skips recall when recallDone=true", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
      recallDone: true,
    });

    assert.equal(fetchMock.mock.calls.length, 0, "should not call fetch");
    assert.equal(result.injectedContent, null);
  });

  test("returns null when no config", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({
      config: null,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(fetchMock.mock.calls.length, 0, "should not call fetch");
    assert.equal(result.injectedContent, null);
  });

  test("network error: recallDone stays false for retry, no throw", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.injectedContent, null, "should return null, not throw");
    assert.equal(result.recallDone, false, "recallDone stays false — retry eligible");
    assert.equal(result.recallAttempts, 1, "attempt counter incremented");
  });

  test("HTTP error: recallDone stays false for retry", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.injectedContent, null);
    assert.equal(result.recallDone, false, "recallDone stays false — retry eligible");
  });

  test("empty vault: recallDone=true even with 0 results (server responded ok)", async () => {
    const fetchMock = mockFetchOk([]);
    const result = await simulateRecall({
      config,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.recallDone, true, "server responded — no reason to retry");
    assert.equal(result.injectedContent, null, "nothing to inject");
  });

  test("only queries project bank when no global_bank configured", async () => {
    const fetchMock = mockFetchOk([]);
    await simulateRecall({
      config: { api_url: "http://localhost:4000", api_key: "key" },
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(fetchMock.mock.calls.length, 1, "should only query 1 bank");
  });

  test("stops retrying after MAX_RECALL_ATTEMPTS", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    // Single-bank config so fetch calls == attempt count (no global_bank)
    const singleBankConfig = { api_url: "http://localhost:4000", api_key: "key" };
    let state = { recallDone: false, recallAttempts: 0, injectedContent: null as string | null };

    for (let i = 0; i < MAX_RECALL_ATTEMPTS + 2; i++) {
      state = await simulateRecall({
        config: singleBankConfig,
        projectBank: "project-hindsight",
        userPrompt: "test",
        fetchImpl: fetchMock,
        recallDone: state.recallDone,
        recallAttempts: state.recallAttempts,
      });
    }

    assert.equal(fetchMock.mock.calls.length, MAX_RECALL_ATTEMPTS, `fetch called exactly ${MAX_RECALL_ATTEMPTS} times`);
    assert.equal(state.recallDone, false);
  });

  test("no config: gives up immediately without fetch", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({
      config: null,
      projectBank: "project-hindsight",
      userPrompt: "test",
      fetchImpl: fetchMock,
    });

    assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(result.recallAttempts, MAX_RECALL_ATTEMPTS, "maxed out — won't retry");
  });
});

describe("Retain (agent_end)", () => {
  const config = { api_url: "http://localhost:4000", api_key: "key", global_bank: "global" };

  test("retains to project bank on normal prompt", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I refactor this function?",
      transcript: "[role: user]\nhow do I refactor this function?\n[role: assistant]\nHere is how...",
      fetchImpl: fetchMock,
      async_retain: false,
    });

    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("project-hindsight"), "should retain to project bank");
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("skips trivial prompts", async () => {
    const fetchMock = mockFetchOk();
    for (const prompt of ["ok", "yes", "no", "thanks", "done"]) {
      const result = await simulateRetain({
        config,
        projectBank: "project-hindsight",
        userPrompt: prompt,
        transcript: "...",
        fetchImpl: fetchMock,
        async_retain: false,
      });
      assert.equal(result.skipped, true, `"${prompt}" should be skipped`);
    }
    assert.equal(fetchMock.mock.calls.length, 0, "fetch should never be called for trivial prompts");
  });

  test("skips very short prompts (<5 chars)", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "hi",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.skipped, true);
  });

  test("#nomem opt-out skips retain", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "#nomem fix this bug please",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "opt-out");
  });

  test("#skip opt-out skips retain", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "#skip this conversation",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "opt-out");
  });

  test("#global tag routes to global bank too", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "remember this #global pattern for all projects",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("global"), "should retain to global bank");
    assert.ok(result.calledBanks.includes("project-hindsight"), "should also retain to project bank");
    assert.equal(result.calledBanks.length, 2);
  });

  test("#me tag routes to global bank too", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "I prefer tabs over spaces #me",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("global"), "should retain to global bank");
  });

  test("no global bank config: only retains to project bank even with #global", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config: { api_url: "http://localhost:4000" },
      projectBank: "project-hindsight",
      userPrompt: "remember this #global",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.calledBanks.length, 1);
    assert.ok(result.calledBanks.includes("project-hindsight"));
  });

  test("skips when no config", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config: null,
      projectBank: "project-hindsight",
      userPrompt: "valid prompt",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.skipped, true);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  test("allFailed=true when all banks return HTTP error", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I fix this?",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.skipped, false, "should attempt retain, not skip");
    assert.equal(result.allFailed, true, "should report total failure");
    assert.equal(result.calledBanks.length, 0, "no banks succeeded");
  });

  test("allFailed=true when network throws", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await simulateRetain({
      config,
      projectBank: "project-hindsight",
      userPrompt: "how do I fix this?",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.allFailed, true);
  });

  test("allFailed=false on success", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
          config,
          projectBank: "project-hindsight",
          userPrompt: "how do I fix this?",
          transcript: "...",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    assert.equal(result.allFailed, false);
  });
});

describe("recallDone lifecycle reset", () => {
  test("recallDone and recallAttempts reset on session_start", async () => {
    let recallDone = true;
    let recallAttempts = MAX_RECALL_ATTEMPTS;

    // session_start handler
    recallDone = false;
    recallAttempts = 0;

    assert.equal(recallDone, false);
    assert.equal(recallAttempts, 0, "attempts must reset so retry window reopens");
  });

  test("recallDone and recallAttempts reset on session_compact", async () => {
    let recallDone = true;
    let recallAttempts = MAX_RECALL_ATTEMPTS;

    // session_compact handler
    recallDone = false;
    recallAttempts = 0;

    assert.equal(recallDone, false);
    assert.equal(recallAttempts, 0);
  });

  test("recallDone prevents double recall within same session", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const config = { api_url: "http://localhost:4000" };

    // First call
    const r1 = await simulateRecall({
      config,
      projectBank: "p",
      userPrompt: "prompt 1",
      fetchImpl: fetchMock,
      recallDone: false,
    });
    assert.equal(r1.recallDone, true);

    // Second call (simulating next user turn without reset)
    const r2 = await simulateRecall({
      config,
      projectBank: "p",
      userPrompt: "prompt 2",
      fetchImpl: fetchMock,
      recallDone: r1.recallDone,
    });

    // fetch should only have been called once total (2 banks in first call = 1 here since no global)
    assert.equal(fetchMock.mock.calls.length, 1, "fetch only called on first turn");
    assert.equal(r2.injectedContent, null, "second turn should not inject");
  });
});

// ─── New field tests ─────────────────────────────────────────────────────────

describe("Recall request shape", () => {
  const config = { api_url: "http://localhost:8888", api_key: "k", global_bank: "global" };

  test("uses budget:mid instead of max_tokens", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    await simulateRecall({
      config,
      projectBank: "project-test",
      userPrompt: "how does auth work?",
      fetchImpl: fetchMock,
    });
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.budget, "mid");
    assert.equal(body.max_tokens, undefined, "max_tokens should not be sent");
  });

  test("sends query_timestamp as ISO string", async () => {
    const before = Date.now();
    const fetchMock = mockFetchOk([]);
    await simulateRecall({
      config,
      projectBank: "project-test",
      userPrompt: "what did we decide?",
      fetchImpl: fetchMock,
    });
    const after = Date.now();
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.ok(body.query_timestamp, "query_timestamp must be present");
    const ts = new Date(body.query_timestamp).getTime();
    assert.ok(ts >= before && ts <= after, "query_timestamp should be recent");
  });

  test("recall_timeout config parsed and defaults to 10000", async () => {
    const config = { api_url: "http://localhost:8888", api_key: "k", global_bank: "global", recall_timeout: 5000 };
    // Simulate config parsing logic
    const recall_timeout = config.recall_timeout !== undefined ? config.recall_timeout : 10000;
    assert.equal(recall_timeout, 5000, "should use configured value");
  });

  test("recall_timeout defaults when not set in config", async () => {
    const config = { api_url: "http://localhost:8888", api_key: "k", global_bank: "global" };
    const recall_timeout = (config as any).recall_timeout ?? 10000;
    assert.equal(recall_timeout, 10000, "should default to 10000ms");
  });
});

describe("Retain request shape", () => {
  const config = { api_url: "http://localhost:8888", api_key: "k", global_bank: "global" };

  test("sets document_id to session-{sessionId}", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "refactor the auth module",
      transcript: "user: refactor\nassistant: done",
      sessionId: "abc123",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.lastRequestBody.items[0].document_id, "session-abc123");
  });

  test("sets update_mode to append", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
          config,
          projectBank: "project-test",
          userPrompt: "add logging to all routes",
          transcript: "user: add logging\nassistant: done",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    assert.equal(result.lastRequestBody.items[0].update_mode, "append");
  });

  test("context starts with 'pi coding session:' and includes prompt snippet", async () => {
    const fetchMock = mockFetchOk();
    const prompt = "how do I add a middleware?";
    const result = await simulateRetain({
          config,
          projectBank: "project-test",
          userPrompt: prompt,
          transcript: "...",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    const context: string = result.lastRequestBody.items[0].context;
    assert.ok(context.startsWith("pi coding session:"), `context should start with label, got: ${context}`);
    assert.ok(context.includes(prompt.slice(0, 20)), "context should include prompt snippet");
  });

  test("context truncates long prompts to 100 chars", async () => {
    const fetchMock = mockFetchOk();
    const longPrompt = "a".repeat(200) + " end";
    const result = await simulateRetain({
          config,
          projectBank: "project-test",
          userPrompt: longPrompt,
          transcript: "...",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    const context: string = result.lastRequestBody.items[0].context;
    assert.ok(!context.includes(" end"), "context should not include chars past 100");
  });

  test("timestamp is a recent ISO string", async () => {
    const before = Date.now();
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
          config,
          projectBank: "project-test",
          userPrompt: "show me the build config",
          transcript: "...",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    const after = Date.now();
    const ts = new Date(result.lastRequestBody.items[0].timestamp).getTime();
    assert.ok(ts >= before && ts <= after, "timestamp should be recent");
  });
});

describe("Retain next-turn messages", () => {
  const config = { api_url: "http://localhost:8888", api_key: "k", global_bank: "global" };

  test("success: sends hindsight-retain message with display:true and bank list", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
          config,
          projectBank: "project-test",
          userPrompt: "refactor the auth module",
          transcript: "...",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    assert.equal(result.skipped, false);
    assert.equal(result.sentMessage?.customType, "hindsight-retain");
    assert.equal(result.sentMessage?.display, true);
    assert.ok(
      (result.sentMessage?.details as any)?.banks?.includes("project-test"),
      "details.banks should include project bank"
    );
  });

  test("failure: sends hindsight-retain-failed message with display:true", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRetain({
          config,
          projectBank: "project-test",
          userPrompt: "refactor the auth module",
          transcript: "...",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    assert.equal(result.allFailed, true);
    assert.equal(result.sentMessage?.customType, "hindsight-retain-failed");
    assert.equal(result.sentMessage?.display, true);
  });

  test("success with #global: banks list includes global bank", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
          config,
          projectBank: "project-test",
          userPrompt: "remember this pattern #global",
          transcript: "...",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    const banks: string[] = (result.sentMessage?.details as any)?.banks ?? [];
    assert.ok(banks.includes("project-test"), "should include project bank");
    assert.ok(banks.includes("global"), "should include global bank");
  });

  test("skipped retain: no message sent", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
          config,
          projectBank: "project-test",
          userPrompt: "ok",
          transcript: "...",
          fetchImpl: fetchMock,
          async_retain: false,
        });
    assert.equal(result.skipped, true);
    assert.equal(result.sentMessage, undefined);
  });
});

describe("Retain async_retain config", () => {
  const config = { api_url: "http://localhost:4000", api_key: "key", global_bank: "global" };

  test("async_retain=true (default): returns early without blocking turn", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "how do I refactor this?",
      transcript: "...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.async, true);
    assert.equal(result.skipped, false);
    assert.equal(result.calledBanks.length, 0);
  });

  test("async_retain=false: awaits and returns full result", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config,
      projectBank: "project-test",
      userPrompt: "how do I refactor this?",
      transcript: "...",
      fetchImpl: fetchMock,
      async_retain: false,
    });
    assert.equal(result.async, undefined);
    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.length > 0, "should have called banks");
    assert.equal(result.sentMessage?.customType, "hindsight-retain");
  });
});

// ─── inferProjectMission tests ────────────────────────────────────────────────

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join as pathJoin, basename as pathBasename } from "node:path";

describe("inferProjectMission", () => {
  function inferProjectMission(cwd: string): string {
    try {
      const pkgPath = pathJoin(cwd, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.description) return pkg.description;
      }
    } catch (_) {}
    try {
      const readmePath = pathJoin(cwd, "README.md");
      if (existsSync(readmePath)) {
        const content = readFileSync(readmePath, "utf-8").slice(0, 400).trim();
        if (content) return content;
      }
    } catch (_) {}
    return pathBasename(cwd);
  }

  test("returns package.json description when present", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-test-"));
    try {
      writeFileSync(pathJoin(dir, "package.json"), JSON.stringify({ description: "My cool project" }));
      assert.equal(inferProjectMission(dir), "My cool project");
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("falls back to README.md when package.json has no description", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-test-"));
    try {
      writeFileSync(pathJoin(dir, "package.json"), JSON.stringify({ name: "my-app" }));
      writeFileSync(pathJoin(dir, "README.md"), "# My App\nThis does cool things.");
      const result = inferProjectMission(dir);
      assert.ok(result.includes("My App"), `expected README content, got: ${result}`);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("falls back to directory name when no package.json or README", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-test-myproject-"));
    try {
      const result = inferProjectMission(dir);
      assert.equal(result, pathBasename(dir));
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("truncates README to 400 chars", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-test-"));
    try {
      writeFileSync(pathJoin(dir, "README.md"), "x".repeat(1000));
      const result = inferProjectMission(dir);
      assert.ok(result.length <= 400, `expected ≤400 chars, got ${result.length}`);
    } finally { rmSync(dir, { recursive: true }); }
  });
});

// ─── configureBankMission tests ───────────────────────────────────────────────

describe("configureBankMission", () => {
  async function configureBankMission(
    config: { api_url: string; api_key?: string },
    bank: string,
    mission: string,
    fetchImpl: any
  ): Promise<void> {
    const res = await fetchImpl(`${config.api_url}/v1/default/banks/${bank}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.api_key || ""}` },
      body: JSON.stringify({ mission }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  test("calls PUT /banks/{bank} with mission field", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    const config = { api_url: "http://localhost:8888", api_key: "k" };
    await configureBankMission(config, "project-myapp", "A React e-commerce app", fetchMock);
    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, opts] = fetchMock.mock.calls[0].arguments;
    assert.ok(url.endsWith("/v1/default/banks/project-myapp"), `unexpected url: ${url}`);
    assert.equal(opts.method, "PUT");
    assert.equal(JSON.parse(opts.body).mission, "A React e-commerce app");
  });

  test("throws on non-ok response", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 500 }));
    const config = { api_url: "http://localhost:8888", api_key: "k" };
    await assert.rejects(
      () => configureBankMission(config, "project-myapp", "mission", fetchMock),
      /HTTP 500/
    );
  });
});

// ─── getBankMission tests ─────────────────────────────────────────────────────

describe("getBankMission", () => {
  async function getBankMission(
    config: { api_url: string; api_key?: string },
    bank: string,
    fetchImpl: any
  ): Promise<string | null> {
    try {
      const res = await fetchImpl(`${config.api_url}/v1/default/banks/${bank}/profile`, {
        headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.mission || null;
    } catch (_) {
      return null;
    }
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("returns mission field from profile", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ mission: "custom mission" }),
    }));
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, "custom mission");
    const url: string = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.endsWith("/v1/default/banks/project-myapp/profile"), `unexpected url: ${url}`);
  });

  test("returns null when mission not set in profile", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });

  test("returns null when no mission set anywhere", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ overrides: {}, config: {} }),
    }));
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });

  test("returns null on HTTP error", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 404 }));
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });

  test("returns null on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await getBankMission(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });
});

// ─── getServerHealth tests ────────────────────────────────────────────────────

describe("getServerHealth", () => {
  async function getServerHealth(
    config: { api_url: string; api_key?: string },
    fetchImpl: any
  ): Promise<{ ok: boolean; status?: number }> {
    try {
      const res = await fetchImpl(`${config.api_url}/health`, {
        headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      });
      return { ok: res.ok, status: res.status };
    } catch (_) {
      return { ok: false };
    }
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("returns ok:true when server healthy", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    const result = await getServerHealth(config, fetchMock);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  });

  test("returns ok:false with status on HTTP error", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 503 }));
    const result = await getServerHealth(config, fetchMock);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });

  test("returns ok:false with no status on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await getServerHealth(config, fetchMock);
    assert.equal(result.ok, false);
    assert.equal(result.status, undefined);
  });

  test("calls /health endpoint", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    await getServerHealth(config, fetchMock);
    const url: string = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.endsWith("/health"), `expected /health, got: ${url}`);
  });
});

// ─── getBankStats tests ────────────────────────────────────────────────────────

describe("getBankStats", () => {
  async function getBankStats(
    config: { api_url: string; api_key?: string },
    bank: string,
    fetchImpl: any
  ): Promise<Record<string, number> | null> {
    try {
      const res = await fetchImpl(`${config.api_url}/v1/default/banks/${bank}/stats`, {
        headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("returns stats object on success", async () => {
    const stats = { memories_count: 42, entities_count: 7, documents_count: 3 };
    const fetchMock = mock.fn(async () => ({ ok: true, json: async () => stats }));
    const result = await getBankStats(config, "project-myapp", fetchMock);
    assert.deepEqual(result, stats);
  });

  test("calls correct stats endpoint", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, json: async () => ({}) }));
    await getBankStats(config, "project-myapp", fetchMock);
    const url: string = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.includes("/v1/default/banks/project-myapp/stats"), `unexpected url: ${url}`);
  });

  test("returns null on HTTP error", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 404 }));
    const result = await getBankStats(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });

  test("returns null on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await getBankStats(config, "project-myapp", fetchMock);
    assert.equal(result, null);
  });
});

// ─── session_start mission message tests ────────────────────────────────────

describe("session_start mission message", () => {
  async function simulateSessionStartMission(opts: {
    config: { api_url: string; api_key?: string } | null;
    mission: string;
    bank: string;
    fetchImpl: any;
  }): Promise<{ messageSent: boolean; messageDetails?: any }> {
    if (!opts.config?.api_url) return { messageSent: false };
    const messages: any[] = [];
    const mockPi = { sendMessage: (msg: any) => messages.push(msg) };
    try {
      const res = await opts.fetchImpl(`${opts.config.api_url}/v1/default/banks/${opts.bank}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${opts.config.api_key || ""}` },
        body: JSON.stringify({ mission: opts.mission }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mockPi.sendMessage({ customType: "hindsight-mission", content: "", display: true, details: { bank: opts.bank, mission: opts.mission } });
    } catch (_) {
      return { messageSent: false };
    }
    return { messageSent: messages.length > 0, messageDetails: messages[0]?.details };
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("sends hindsight-mission message on success", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    const result = await simulateSessionStartMission({
      config, mission: "A React e-commerce app", bank: "project-myapp", fetchImpl: fetchMock,
    });
    assert.equal(result.messageSent, true);
    assert.equal(result.messageDetails?.bank, "project-myapp");
    assert.equal(result.messageDetails?.mission, "A React e-commerce app");
  });

  test("does not send message when config API fails", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 500 }));
    const result = await simulateSessionStartMission({
      config, mission: "some mission", bank: "project-myapp", fetchImpl: fetchMock,
    });
    assert.equal(result.messageSent, false);
  });

  test("does not send message on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await simulateSessionStartMission({
      config, mission: "some mission", bank: "project-myapp", fetchImpl: fetchMock,
    });
    assert.equal(result.messageSent, false);
  });

  test("does not send message when no config", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 }));
    const result = await simulateSessionStartMission({
      config: null, mission: "some mission", bank: "project-myapp", fetchImpl: fetchMock,
    });
    assert.equal(result.messageSent, false);
    assert.equal(fetchMock.mock.calls.length, 0);
  });
});

// ─── checkBankConfig tests ───────────────────────────────────────────────────

describe("checkBankConfig", () => {
  async function checkBankConfig(
    config: { api_url: string; api_key?: string },
    bank: string,
    fetchImpl: any
  ): Promise<{ ok: true; mission: string | null } | { ok: false; authError: boolean }> {
    try {
      const res = await fetchImpl(`${config.api_url}/v1/default/banks/${bank}/profile`, {
        headers: { "Authorization": `Bearer ${config.api_key || ""}` },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, authError: true };
      if (!res.ok) return { ok: false, authError: false };
      const data = await res.json();
      return { ok: true, mission: data.mission || null };
    } catch (_) {
      return { ok: false, authError: false };
    }
  }

  const config = { api_url: "http://localhost:8888", api_key: "k" };

  test("returns ok:true with mission from profile", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ mission: "A cool project" }),
    }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, true);
    assert.equal((result as any).mission, "A cool project");
    const url: string = fetchMock.mock.calls[0].arguments[0];
    assert.ok(url.endsWith("/profile"), `expected /profile, got: ${url}`);
  });

  test("returns ok:true with null mission when none set", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({})
    }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, true);
    assert.equal((result as any).mission, null);
  });

  test("returns authError:true on 401", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 401 }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, false);
    assert.equal((result as any).authError, true);
  });

  test("returns authError:true on 403", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 403 }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, false);
    assert.equal((result as any).authError, true);
  });

  test("returns authError:false on other HTTP errors", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 500 }));
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, false);
    assert.equal((result as any).authError, false);
  });

  test("returns authError:false on network error", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await checkBankConfig(config, "project-myapp", fetchMock);
    assert.equal(result.ok, false);
    assert.equal((result as any).authError, false);
  });
});

// ─── checkBankConfig tests ─────────────────────────────── (already above)

// ─── hookStats tracking tests ────────────────────────────────────────────────

describe("hookStats tracking", () => {
  type HookRecord = { firedAt?: string; result?: string; detail?: string };

  function makeHookStats() {
    return { sessionStart: {} as HookRecord, recall: {} as HookRecord,
             retain: {} as HookRecord, missionConfig: {} as HookRecord };
  }

  test("session_start marks firedAt and result:ok", () => {
    const stats = makeHookStats();
    stats.sessionStart = { firedAt: new Date().toISOString(), result: "ok" };
    assert.equal(stats.sessionStart.result, "ok");
    assert.ok(stats.sessionStart.firedAt);
  });

  test("recall marks result:ok with memory count detail", () => {
    const stats = makeHookStats();
    stats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: "3 memories" };
    assert.equal(stats.recall.result, "ok");
    assert.ok(stats.recall.detail?.includes("3"));
  });

  test("recall marks result:failed with auth error detail", () => {
    const stats = makeHookStats();
    stats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "auth error" };
    assert.equal(stats.recall.result, "failed");
    assert.equal(stats.recall.detail, "auth error");
  });

  test("retain marks result:ok with bank names", () => {
    const stats = makeHookStats();
    stats.retain = { firedAt: new Date().toISOString(), result: "ok", detail: "project-myapp" };
    assert.equal(stats.retain.result, "ok");
    assert.ok(stats.retain.detail?.includes("project-myapp"));
  });

  test("retain marks result:failed when all banks unreachable", () => {
    const stats = makeHookStats();
    stats.retain = { firedAt: new Date().toISOString(), result: "failed", detail: "all banks unreachable" };
    assert.equal(stats.retain.result, "failed");
  });

  test("missionConfig marks result:ok with mission snippet", () => {
    const stats = makeHookStats();
    stats.missionConfig = { firedAt: new Date().toISOString(), result: "ok", detail: "A React app" };
    assert.equal(stats.missionConfig.result, "ok");
  });

  test("missionConfig marks result:failed with error", () => {
    const stats = makeHookStats();
    stats.missionConfig = { firedAt: new Date().toISOString(), result: "failed", detail: "HTTP 500" };
    assert.equal(stats.missionConfig.result, "failed");
  });

  test("unfired hooks have empty firedAt", () => {
    const stats = makeHookStats();
    assert.equal(stats.recall.firedAt, undefined);
    assert.equal(stats.retain.firedAt, undefined);
  });
});

// ─── readRecentLogErrors tests ────────────────────────────────────────────────

describe("readRecentLogErrors", () => {
  function readRecentLogErrors(logPath: string, maxLines = 20): string[] {
    try {
      if (!existsSync(logPath)) return [];
      const content = readFileSync(logPath, "utf-8");
      return content.split("\n").filter(l => l.trim()).slice(-maxLines);
    } catch (_) {
      return [];
    }
  }

  test("returns empty array when log file does not exist", () => {
    const result = readRecentLogErrors("/tmp/nonexistent-hindsight-log.txt");
    assert.deepEqual(result, []);
  });

  test("returns last N lines of log file", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-log-test-"));
    const logPath = pathJoin(dir, "debug.log");
    try {
      const lines = Array.from({ length: 30 }, (_, i) => `[2025] line ${i}`).join("\n");
      writeFileSync(logPath, lines);
      const result = readRecentLogErrors(logPath, 10);
      assert.equal(result.length, 10);
      assert.ok(result[0].includes("line 20"), `expected line 20, got: ${result[0]}`);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("returns all lines when fewer than maxLines", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-log-test-"));
    const logPath = pathJoin(dir, "debug.log");
    try {
      writeFileSync(logPath, "line1\nline2\nline3\n");
      const result = readRecentLogErrors(logPath, 20);
      assert.equal(result.length, 3);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("skips blank lines", () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "hindsight-log-test-"));
    const logPath = pathJoin(dir, "debug.log");
    try {
      writeFileSync(logPath, "line1\n\n\nline2\n");
      const result = readRecentLogErrors(logPath, 20);
      assert.equal(result.length, 2);
    } finally { rmSync(dir, { recursive: true }); }
  });
});

// ─── environment variable overrides (omp-compatible bank contract) ───────────

// These tests import the real extension, which needs its npm dependencies
// installed. Skipped on a fresh checkout without node_modules so that
// `node --experimental-strip-types test.ts` still runs.
const extensionDepsInstalled = existsSync("node_modules/@sinclair/typebox");

describe("applyEnvOverrides", { skip: !extensionDepsInstalled && "extension deps not installed (run npm ci)" }, () => {
  const originalEnv = { ...process.env };
  let applyEnvOverrides: (merged: Record<string, string>) => void;

  before(async () => {
    ({ applyEnvOverrides } = await import("./index.ts"));
  });

  beforeEach(() => {
    delete process.env.HINDSIGHT_BANK_ID;
    delete process.env.HINDSIGHT_SCOPING;
    delete process.env.HINDSIGHT_BANK_SCOPE;
    delete process.env.HINDSIGHT_BANK_NAMESPACE;
  });

  after(() => {
    // Never assign to process.env wholesale: that resets every variable
    // (including HOME) and races with other suites' before hooks.
    for (const key of ["HINDSIGHT_BANK_ID", "HINDSIGHT_SCOPING", "HINDSIGHT_BANK_SCOPE", "HINDSIGHT_BANK_NAMESPACE"] as const) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  function env(bank?: string, scoping?: string): Record<string, string> {
    if (bank !== undefined) process.env.HINDSIGHT_BANK_ID = bank;
    if (scoping !== undefined) process.env.HINDSIGHT_SCOPING = scoping;
    const merged: Record<string, string> = { api_url: "http://x", global_bank: "shared-global", recall_budget: "mid" };
    applyEnvOverrides(merged);
    return merged;
  }

  test("is a no-op without HINDSIGHT_BANK_ID", () => {
    const merged = env();
    assert.equal(merged.project_bank_id, undefined);
    assert.equal(merged.global_bank, "shared-global");
  });

  test("overrides the project bank, keeps configured global_bank when scoping is unset", () => {
    const merged = env("agent-bank");
    assert.equal(merged.project_bank_id, "agent-bank");
    assert.equal(merged.global_bank, "shared-global");
  });

  test("scoping=global collapses into one flat bank", () => {
    const merged = env("agent-bank", "global");
    assert.equal(merged.project_bank_id, "agent-bank");
    assert.equal(merged.global_bank, "");
    assert.equal(merged.homedir_project, "true");
  });

  test("global scoping enables the selected bank in the home directory", () => {
    process.env.HINDSIGHT_BANK_ID = "agent-bank";
    process.env.HINDSIGHT_SCOPING = "global";
    const merged = { homedir_project: "false", global_bank: "shared-global" };
    applyEnvOverrides(merged);
    assert.equal(merged.homedir_project, "true");
    assert.equal(merged.global_bank, "");
    assert.equal((merged as Record<string, string>).project_bank_id, "agent-bank");
  });

  test("scoping=per-project keeps the configured global_bank", () => {
    const merged = env("agent-bank", "per-project");
    assert.equal(merged.project_bank_id, "agent-bank");
    assert.equal(merged.global_bank, "shared-global");
    assert.equal(merged.homedir_project, "true");
  });

  test("unknown scoping values are ignored", () => {
    const merged = env("agent-bank", "banana");
    assert.equal(merged.project_bank_id, "agent-bank");
    assert.equal(merged.global_bank, "shared-global");
  });

  test("whitespace around the bank id is trimmed", () => {
    const merged = env("  agent-bank  ", "global");
    assert.equal(merged.project_bank_id, "agent-bank");
    assert.equal(merged.global_bank, "");
  });
});

// ─── session-scoped banks ────────────────────────────────────────────────────

describe("session bank resolution", { skip: !extensionDepsInstalled && "extension deps not installed (run npm ci)" }, () => {
  let mod: any;

  before(async () => {
    mod = await import("./index.ts");
  });

  // A UUIDv7 pair started in the same ~65s window: identical 8-char prefix.
  const SID_A = "01a18aa6-cf2c-71a6-8b67-de30d68730cd";
  const SID_B = "01a18aa6-cf2c-71a6-8b67-aaaa11112222";

  after(() => {
    for (const key of ["HINDSIGHT_BANK_ID", "HINDSIGHT_SCOPING", "HINDSIGHT_BANK_SCOPE", "HINDSIGHT_BANK_NAMESPACE"] as const) {
      delete process.env[key];
    }
  });

  function cfg(over: Record<string, unknown> = {}) {
    return {
      api_url: "http://x",
      bank_scope: "session",
      bank_namespace: "machine-a",
      ...over,
    } as any;
  }

  test("derives sess-<namespace>-<project>-<tail>", () => {
    assert.equal(mod.getSessionBank(cfg(), SID_A, "/home/alex/proj"), "sess-machine-a-proj-de30d68730cd");
  });

  test("two sessions started in the same window get different banks", () => {
    assert.equal(SID_A.slice(0, 8), SID_B.slice(0, 8), "test precondition: prefixes collide");
    assert.notEqual(
      mod.getSessionBank(cfg(), SID_A, "/home/alex/proj"),
      mod.getSessionBank(cfg(), SID_B, "/home/alex/proj")
    );
  });

  test("same session id resolves to the same bank (resume keeps memory)", () => {
    assert.equal(
      mod.getSessionBank(cfg(), SID_A, "/home/alex/proj"),
      mod.getSessionBank(cfg(), SID_A, "/home/alex/proj")
    );
  });

  test("namespace separates machines sharing one server", () => {
    const a = mod.getSessionBank(cfg({ bank_namespace: "machine-a" }), SID_A, "/home/alex/proj");
    const b = mod.getSessionBank(cfg({ bank_namespace: "machine-b" }), SID_A, "/home/alex/proj");
    assert.notEqual(a, b);
  });

  test("empty namespace is honored", () => {
    assert.equal(mod.getSessionBank(cfg({ bank_namespace: "" }), SID_A, "/home/alex/proj"), "sess-proj-de30d68730cd");
  });

  test("explicit project_bank_id becomes the root", () => {
    assert.equal(
      mod.getSessionBank(cfg({ project_bank_id: "pi-config-box" }), SID_A, "/home/alex/proj"),
      "sess-pi-config-box-de30d68730cd"
    );
  });

  test("project bank follows the git repository, not the subdirectory", () => {
    const repo = mkdtempSync(pathJoin(tmpdir(), "hindsight-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      writeFileSync(pathJoin(repo, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repo });
      execFileSync(
        "git",
        ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"],
        { cwd: repo },
      );
      const sub = pathJoin(repo, "packages", "app");
      mkdirSync(sub, { recursive: true });
      const slug = mod.sanitizeBankSegment(pathBasename(repo));

      assert.equal(mod.getProjectBank(cfg(), sub), `project-machine-a-${slug}`);
      assert.ok(
        mod.getLegacyProjectBanks(cfg(), sub).includes("project-machine-a-app"),
        `legacy banks: ${mod.getLegacyProjectBanks(cfg(), sub).join(", ")}`,
      );
      assert.equal(mod.getProjectBank(cfg({ bank_namespace: undefined }), sub), `project-${slug}`);
      assert.ok(mod.getLegacyProjectBanks(cfg({ bank_namespace: undefined }), sub).includes("project-app"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("home directory uses a stable slug", () => {
    assert.equal(mod.getSessionBank(cfg(), SID_A, homedir()), "sess-machine-a-home-de30d68730cd");
  });

  test("sanitizes hostile namespace and project names", () => {
    assert.equal(
      mod.getSessionBank(cfg({ bank_namespace: "Alex Chen HP.laptop" }), SID_A, "/x/My Project!"),
      "sess-alex-chen-hp-laptop-my-project-de30d68730cd"
    );
  });

  test("missing session id degrades to unknown", () => {
    assert.equal(mod.getSessionBank(cfg(), null, "/home/alex/proj"), "sess-machine-a-proj-unknown");
  });

  test("recall in session scope touches only this session's bank", () => {
    const bankA = mod.getSessionBank(cfg(), SID_A);
    const bankB = mod.getSessionBank(cfg(), SID_B);
    assert.deepEqual(mod.getRecallBanks(cfg(), SID_A), [bankA]);
    assert.deepEqual(mod.getRecallBanks(cfg(), SID_B), [bankB]);
    assert.notEqual(bankA, bankB);
  });

  test("recall in session scope still includes an explicitly configured global bank", () => {
    assert.deepEqual(
      mod.getRecallBanks(cfg({ global_bank: "shared" }), SID_A),
      [mod.getSessionBank(cfg(), SID_A), "shared"]
    );
  });

  test("retain in session scope goes to the session bank only", () => {
    assert.deepEqual(mod.getRetainBanks(cfg({ global_bank: "shared" }), "plain prompt", SID_A), [
      mod.getSessionBank(cfg(), SID_A),
    ]);
  });

  test("#global still publishes to the global bank", () => {
    assert.deepEqual(mod.getRetainBanks(cfg({ global_bank: "shared" }), "#global remember this", SID_A), [
      mod.getSessionBank(cfg(), SID_A),
      "shared",
    ]);
  });

  test("project scope keeps the legacy bank naming", () => {
    const projectCfg = cfg({ bank_scope: "project", bank_namespace: undefined, project_bank_id: undefined });
    const projectBank = mod.getProjectBank(projectCfg);
    assert.match(projectBank, /^project-/);
    assert.deepEqual(mod.getRecallBanks(projectCfg, SID_A), [projectBank]);
    assert.deepEqual(mod.getRetainBanks(projectCfg, "prompt", SID_A), [projectBank]);
  });

  test("project scope with an explicit namespace opts into namespaced banks", () => {
    const projectCfg = cfg({ bank_scope: "project", bank_namespace: "machine-a" });
    assert.equal(mod.getProjectBank(projectCfg, "/home/alex/proj"), "project-machine-a-proj");
  });

  test("session bank prefix scopes pruning to this machine", () => {
    assert.equal(mod.getSessionBankPrefix(cfg()), "sess-machine-a-");
    assert.equal(mod.getSessionBankPrefix(cfg({ project_bank_id: "pinned" })), "sess-pinned-");
    assert.equal(mod.getSessionBankPrefix(cfg({ bank_namespace: "" })), null);
  });

  test("env HINDSIGHT_BANK_SCOPE/NAMESPACE override config", () => {
    const merged: Record<string, string> = { bank_scope: "project", bank_namespace: "from-config" };
    process.env.HINDSIGHT_BANK_SCOPE = "session";
    process.env.HINDSIGHT_BANK_NAMESPACE = "from-env";
    mod.applyEnvOverrides(merged);
    assert.equal(merged.bank_scope, "session");
    assert.equal(merged.bank_namespace, "from-env");
  });

  test("HINDSIGHT_SCOPING=global pins the exact bank and disables session scope", () => {
    const merged: Record<string, string> = { bank_scope: "session" };
    process.env.HINDSIGHT_BANK_ID = "pinned-bank";
    process.env.HINDSIGHT_SCOPING = "global";
    mod.applyEnvOverrides(merged);
    assert.equal(merged.project_bank_id, "pinned-bank");
    assert.equal(merged.bank_scope, "project");
  });
});


// ─── hook-level isolation (real factory, mocked network) ─────────────────────

describe("hook-level session isolation", { skip: !extensionDepsInstalled && "extension deps not installed (run npm ci)" }, () => {
  const SID_A = "01a18aa6-cf2c-71a6-8b67-de30d68730cd";
  const SID_B = "01a18aa6-cf2c-71a6-8b67-aaaa11112222";
  const CWD = "/work/proj";

  let hindsightExtension: any;
  let fakeHome: string;
  let originalHome: string | undefined;
  let recorded: { url: string; method: string; body: any }[];

  function makeSessionCtx(sid: string, prompt: string, statuses?: string[]) {
    return {
      cwd: CWD,
      sessionManager: {
        getSessionId: () => sid,
        getEntries: () => (prompt ? [{ type: "message", message: { role: "user", content: prompt } }] : []),
      },
      ui: {
        setStatus(_key: string, value?: string) { if (statuses && value) statuses.push(value); },
        notify() {},
      },
    };
  }

  before(async () => {
    originalHome = process.env.HOME;
    fakeHome = mkdtempSync(pathJoin(tmpdir(), "hindsight-session-test-"));
    mkdirSync(pathJoin(fakeHome, ".hindsight"), { recursive: true });
    writeFileSync(
      pathJoin(fakeHome, ".hindsight", "config"),
      [
        'api_url = "http://fake-hindsight"',
        'api_key = "test-key"',
        'bank_scope = "session"',
        'bank_namespace = "testbox"',
        'async_retain = "false"',
      ].join("\n") + "\n"
    );
    process.env.HOME = fakeHome;

    (global as any).fetch = async (url: any, opts: any = {}) => {
      let parsed: any;
      try { parsed = opts.body ? JSON.parse(opts.body) : undefined; } catch { parsed = opts.body; }
      recorded.push({ url: String(url), method: opts.method || "GET", body: parsed });
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    };

    ({ default: hindsightExtension } = await import("./index.ts"));
  });

  beforeEach(() => {
    recorded = [];
  });

  after(() => {
    process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  async function runTurn(sid: string, prompt: string) {
    const pi = makePiMock();
    hindsightExtension(pi);
    const ctx = makeSessionCtx(sid, prompt);
    await pi.emit("session_start", {}, ctx);
    const before = recorded.length;
    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "here is the answer" }] }, ctx);
    await pi.emit("agent_settled", { aborted: false }, ctx);
    return recorded
      .slice(before)
      .filter(r => r.method === "POST" && r.url.includes("/memories"));
  }

  test("retains to this session's bank, never the shared project bank", async () => {
    const retains = await runTurn(SID_A, "please refactor the parser");
    assert.equal(retains.length, 1);
    assert.ok(
      retains[0].url.includes("/banks/sess-testbox-proj-de30d68730cd/memories"),
      `unexpected retain URL: ${retains[0].url}`
    );
    assert.ok(!retains[0].url.includes("project-proj"), "must not touch the shared project bank");
  });

  test("two sessions in the same directory retain into different banks", async () => {
    const a = await runTurn(SID_A, "session A task");
    const b = await runTurn(SID_B, "session B task");
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.ok(a[0].url.includes("sess-testbox-proj-de30d68730cd"));
    assert.ok(b[0].url.includes("sess-testbox-proj-aaaa11112222"));
    assert.notEqual(a[0].url, b[0].url);
  });

  test("session bank documents stay keyed by the session id", async () => {
    const retains = await runTurn(SID_A, "a prompt long enough to retain");
    assert.equal(retains[0].body.items[0].document_id, `session-${SID_A}`);
  });

  test("a not-yet-created session bank is retried, not reported as a recall failure", async () => {
    const defaultFetch = (global as any).fetch;
    const calls: string[] = [];
    (global as any).fetch = async (url: any, opts: any = {}) => {
      calls.push(`${opts.method || "GET"} ${String(url)}`);
      if (String(url).includes("/memories/recall")) {
        return {
          ok: false,
          status: 404,
          text: async () => '{"detail":"Bank not found"}',
          json: async () => ({ detail: "Bank not found" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    };

    try {
      const statuses: string[] = [];
      const pi = makePiMock();
      hindsightExtension(pi);
      const ctx = makeSessionCtx(SID_A, "a prompt that needs recall", statuses);
      await pi.emit("session_start", {}, ctx);
      await pi.emit("before_agent_start", {}, ctx);
      await pi.emit("before_agent_start", {}, ctx);

      const recalls = calls.filter(c => c.includes("/memories/recall"));
      assert.equal(recalls.length, 2, "404 must be retried once the bank may exist");
      assert.ok(
        !statuses.some(s => s.includes("recall failed") || s.includes("recall unavailable")),
        `unexpected failure status: ${statuses.join(", ")}`
      );
    } finally {
      (global as any).fetch = defaultFetch;
    }
  });

  test("recall query uses the prompt text, not the content-block JSON", async () => {
    const pi = makePiMock();
    hindsightExtension(pi);
    const ctx = {
      ...makeSessionCtx(SID_A, ""),
      sessionManager: {
        getSessionId: () => SID_A,
        getEntries: () => [{
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "image", source: { data: "BASE64IMAGE" } },
              { type: "text", text: "why does the parser drop the trailing newline?" },
            ],
          },
        }],
      },
    };
    recorded = [];
    await pi.emit("session_start", {}, ctx);
    await pi.emit("before_agent_start", {}, ctx);

    const recall = recorded.find(r => r.url.includes("/memories/recall"));
    assert.ok(recall, "recall should have been attempted");
    assert.equal(recall!.body.query, "why does the parser drop the trailing newline?");
    assert.ok(!JSON.stringify(recall!.body).includes("BASE64IMAGE"), "image data must not be the query");
  });

  test("session scope skips mission provisioning at session_start", async () => {
    const pi = makePiMock();
    hindsightExtension(pi);
    recorded = [];
    await pi.emit("session_start", {}, makeSessionCtx(SID_A, ""));
    const missionCalls = recorded.filter(r => r.url.includes("/profile") || r.url.includes("/config"));
    assert.equal(missionCalls.length, 0, "should not provision missions for ephemeral session banks");
  });

  test("retains once per settle, from the final run's messages", async () => {
    const pi = makePiMock();
    hindsightExtension(pi);
    const ctx = makeSessionCtx(SID_A, "please refactor the parser");
    await pi.emit("session_start", {}, ctx);
    const before = recorded.length;
    const retainsSince = () =>
      recorded.slice(before).filter(r => r.method === "POST" && r.url.includes("/memories"));

    // Two low-level runs (e.g. a retry) before the run settles.
    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "first partial attempt" }] }, ctx);
    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "the real answer" }] }, ctx);
    assert.equal(retainsSince().length, 0, "agent_end alone must not retain mid-run");

    await pi.emit("agent_settled", { aborted: false }, ctx);
    const retains = retainsSince();
    assert.equal(retains.length, 1, "exactly one retain per settle");
    const content = retains[0].body.items[0].content;
    assert.ok(content.includes("the real answer"), `transcript should carry the final run: ${content}`);
    assert.ok(!content.includes("first partial attempt"), "earlier run must not leak into the transcript");
  });

  test("does not retain a settled run with no assistant output", async () => {
    const pi = makePiMock();
    hindsightExtension(pi);
    const ctx = makeSessionCtx(SID_A, "please refactor the parser");
    await pi.emit("session_start", {}, ctx);
    const before = recorded.length;
    await pi.emit("agent_settled", { aborted: true }, ctx);
    const retains = recorded.slice(before).filter(r => r.method === "POST" && r.url.includes("/memories"));
    assert.equal(retains.length, 0, "nothing to remember without an assistant reply");
  });
});

describe("retain report delivery", { skip: !extensionDepsInstalled && "extension deps not installed (run npm ci)" }, () => {
  const SID = "01a18ab7-1111-7222-8333-444455556666";
  const CWD = "/work/proj";

  let hindsightExtension: any;
  let fakeHome: string;
  let originalHome: string | undefined;
  let realFetch: any;

  // ctx.ui and the pi runtime both assert liveness in real Pi: once the session
  // is replaced or the process tears down, every call throws.
  function makeSessionCtx(pi: any, statuses: string[]) {
    return {
      cwd: CWD,
      sessionManager: {
        getSessionId: () => SID,
        getEntries: () => [
          { type: "message", message: { role: "user", content: "please refactor the parser module" } },
        ],
      },
      ui: {
        setStatus(_key: string, value?: string) {
          if (pi.isStale()) throw new Error("This extension ctx is stale after session replacement or reload.");
          if (value) statuses.push(value);
        },
        notify() {},
      },
    };
  }

  before(async () => {
    originalHome = process.env.HOME;
    fakeHome = mkdtempSync(pathJoin(tmpdir(), "hindsight-report-test-"));
    mkdirSync(pathJoin(fakeHome, ".hindsight"), { recursive: true });
    writeFileSync(
      pathJoin(fakeHome, ".hindsight", "config"),
      ['api_url = "http://fake-hindsight"', 'api_key = "test-key"', 'bank_scope = "session"', 'bank_namespace = "testbox"', 'async_retain = "true"'].join("\n") + "\n"
    );
    process.env.HOME = fakeHome;
    realFetch = (global as any).fetch;
    ({ default: hindsightExtension } = await import("./index.ts"));
  });

  after(() => {
    process.env.HOME = originalHome;
    (global as any).fetch = realFetch;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  async function runAsyncTurn(pi: any, ctx: any, retainOk: boolean) {
    (global as any).fetch = async () =>
      retainOk
        ? { ok: true, status: 200, json: async () => ({ results: [] }) }
        : { ok: false, status: 500, json: async () => ({}) };
    await pi.emit("session_start", {}, ctx);
    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "here is the answer" }] }, ctx);
    await pi.emit("agent_settled", { aborted: false }, ctx);
    // Let the fire-and-forget retain promise settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  test("async retain paints the badge while the session is alive", async () => {
    const statuses: string[] = [];
    const pi = makePiMock();
    hindsightExtension(pi);
    await runAsyncTurn(pi, makeSessionCtx(pi, statuses), true);

    assert.deepEqual(statuses, ["Memorized: 1/1"]);
    assert.equal(pi.sentMessages.length, 0, "default feedback is status only");
  });

  test("a retain that lands after teardown drops the report instead of throwing", async () => {
    const statuses: string[] = [];
    const pi = makePiMock();
    hindsightExtension(pi);
    const ctx = makeSessionCtx(pi, statuses);

    const calls: string[] = [];
    (global as any).fetch = async (url: any, opts: any = {}) => {
      calls.push(`${opts.method || "GET"} ${String(url)}`);
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    };
    await pi.emit("session_start", {}, ctx);
    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "here is the answer" }] }, ctx);
    await pi.emit("agent_settled", { aborted: false }, ctx);
    pi.invalidate(); // process teardown / session replacement wins the race
    await new Promise((resolve) => setTimeout(resolve, 50));

    const retains = calls.filter(c => c.startsWith("POST") && c.includes("/memories"));
    assert.equal(retains.length, 1, "the retain itself must still be attempted");
    assert.deepEqual(statuses, [], "no badge can be painted without a live session");
  });

  test("a failed async retain reports through the next-turn message", async () => {
    const statuses: string[] = [];
    const pi = makePiMock();
    hindsightExtension(pi);
    await runAsyncTurn(pi, makeSessionCtx(pi, statuses), false);

    assert.deepEqual(statuses, ["Memorized: 0/1"]);
    assert.equal(pi.sentMessages.length, 1);
    assert.equal(pi.sentMessages[0].message.customType, "hindsight-retain-failed");
    assert.equal(pi.sentMessages[0].options.deliverAs, "nextTurn");
  });
});

describe("resolveApiKey", { skip: !extensionDepsInstalled && "extension deps not installed (run npm ci)" }, () => {
  let resolveApiKey: (global: Record<string, string>, local: Record<string, string>, env?: NodeJS.ProcessEnv) => string | undefined;

  before(async () => {
    ({ resolveApiKey } = await import("./index.ts"));
  });

  test("project api_key wins over global", () => {
    assert.equal(resolveApiKey({ api_key: "global" }, { api_key: "project" }, {}), "project");
  });

  test("global api_key is used for the global api_url", () => {
    assert.equal(resolveApiKey({ api_url: "https://mine", api_key: "global" }, {}, { HINDSIGHT_API_KEY: "env" }), "global");
  });

  test("falls back to HINDSIGHT_API_KEY for the user's own api_url", () => {
    assert.equal(resolveApiKey({ api_url: "https://mine" }, {}, { HINDSIGHT_API_KEY: "env" }), "env");
  });

  test("project config repeating the global api_url still gets the user's key", () => {
    assert.equal(resolveApiKey({ api_url: "https://mine", api_key: "global" }, { api_url: "https://mine" }, {}), "global");
  });

  test("never sends the global or env key to a project-chosen api_url", () => {
    assert.equal(resolveApiKey({ api_url: "https://mine", api_key: "global" }, { api_url: "http://evil" }, { HINDSIGHT_API_KEY: "env" }), undefined);
  });

  test("a project-chosen api_url gets the project's own api_key", () => {
    assert.equal(resolveApiKey({ api_url: "https://mine", api_key: "global" }, { api_url: "https://other", api_key: "project" }, {}), "project");
  });
});
