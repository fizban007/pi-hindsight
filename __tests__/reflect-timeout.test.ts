/**
 * Tests for the recall/reflect timeout split.
 *
 * Strategy (same as mission-setup.test.ts):
 * - Set process.env.HOME to a temp dir → os.homedir() returns it
 * - Write a ~/.hindsight/config there
 * - Stub global fetch to hang until the request is aborted
 * - Drive the real hindsight_reflect tool through a minimal Pi mock
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface Registered {
  tools: Record<string, any>;
  commands: Record<string, any>;
}

function makePiMock(): { pi: any; registered: Registered } {
  const registered: Registered = { tools: {}, commands: {} };
  const pi = {
    on() {},
    registerTool(spec: any) {
      registered.tools[spec.name] = spec;
    },
    registerCommand(name: string, spec: any) {
      registered.commands[name] = spec;
    },
    registerMessageRenderer() {},
    getActiveTools() {
      return [];
    },
    sendMessage() {},
  };
  return { pi, registered };
}

/** Rejects the way fetch does when AbortController fires. */
function hangingFetch(calls: { signal?: AbortSignal }[] = []) {
  return vi.fn((_url: string, opts: any) => {
    calls.push({ signal: opts?.signal });
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        (err as any).name = "AbortError";
        reject(err);
      });
    });
  });
}

describe("timeout helpers (pure)", () => {
  let mod: any;

  beforeEach(async () => {
    mod = await import("../index.ts");
  });

  it("defaults recall to 10s and reflect to 60s", () => {
    expect(mod.getRecallTimeoutMs({})).toBe(10_000);
    expect(mod.getReflectTimeoutMs({})).toBe(60_000);
    expect(mod.RECALL_TIMEOUT_DEFAULT_MS).toBe(10_000);
    expect(mod.REFLECT_TIMEOUT_DEFAULT_MS).toBe(60_000);
  });

  it("keeps the two knobs independent", () => {
    expect(mod.getRecallTimeoutMs({ recall_timeout: 2500 })).toBe(2500);
    expect(mod.getReflectTimeoutMs({ recall_timeout: 2500 })).toBe(60_000);
    expect(mod.getRecallTimeoutMs({ reflect_timeout: 90_000 })).toBe(10_000);
    expect(mod.getReflectTimeoutMs({ reflect_timeout: 90_000 })).toBe(90_000);
  });

  it("reads the timeouts from the environment regardless of bank pinning", () => {
    const merged: Record<string, string> = {};
    vi.stubEnv("HINDSIGHT_REFLECT_TIMEOUT", "120000");
    vi.stubEnv("HINDSIGHT_RECALL_TIMEOUT", "4000");
    try {
      mod.applyEnvOverrides(merged);
      expect(merged.reflect_timeout).toBe("120000");
      expect(merged.recall_timeout).toBe("4000");
      // No HINDSIGHT_BANK_ID: the bank path stays untouched.
      expect(merged.project_bank_id).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("hindsight_reflect deadline", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hindsight-reflect-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    delete process.env.HINDSIGHT_REFLECT_TIMEOUT;
    delete process.env.HINDSIGHT_RECALL_TIMEOUT;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function writeConfig(body: string) {
    mkdirSync(join(home, ".hindsight"), { recursive: true });
    writeFileSync(join(home, ".hindsight", "config"), body);
  }

  it("aborts on reflect_timeout, not recall_timeout", async () => {
    writeConfig(
      [
        'api_url = "http://localhost:8888"',
        'api_key = "k"',
        'bank_scope = "project"',
        'bank_namespace = "testhost"',
        "recall_timeout = 5000",
        "reflect_timeout = 150",
      ].join("\n"),
    );

    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { default: hindsightExtension } = await import("../index.ts");
    const { pi, registered } = makePiMock();
    (hindsightExtension as (p: ExtensionAPI) => void)(pi);

    const ctx = { sessionManager: { getSessionId: () => "sess-abc" }, ui: { notify() {} } };
    const started = Date.now();
    const result = await registered.tools.hindsight_reflect.execute(
      "id",
      { query: "what did we decide?" },
      undefined,
      undefined,
      ctx,
    );
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    // Governed by reflect_timeout (150ms), nowhere near recall_timeout (5000ms).
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(2000);
    expect(result.content[0].text).toContain("Reflect timed out after 150ms");
    expect(result.content[0].text).toContain("reflect_timeout");
    // The abort actually reached the request rather than being ignored.
    expect(fetchMock.mock.calls[0][0]).toContain("/reflect");
  });

  it("succeeds normally and sends the query without extra timeouts", async () => {
    writeConfig(
      [
        'api_url = "http://localhost:8888"',
        'api_key = "k"',
        'bank_scope = "project"',
        'bank_namespace = "testhost"',
      ].join("\n"),
    );

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "answer" }) }));
    vi.stubGlobal("fetch", fetchMock);

    const { default: hindsightExtension } = await import("../index.ts");
    const { pi, registered } = makePiMock();
    (hindsightExtension as (p: ExtensionAPI) => void)(pi);

    const ctx = { sessionManager: { getSessionId: () => "sess-abc" }, ui: { notify() {} } };
    const result = await registered.tools.hindsight_reflect.execute(
      "id",
      { query: "what did we decide?" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("answer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).query).toBe("what did we decide?");
  });
});
