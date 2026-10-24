import { afterEach, expect, it, vi } from "vitest";
import { runtimeEnv } from "../src/runtimes/env.js";
import { JsonProcess } from "../src/runtimes/process.js";

afterEach(() => vi.unstubAllEnvs());

it("removes worker internals while retaining user environment, resolved PATH and granted secrets", () => {
  const source = {
    HOME: "/home/user", PATH: "/resolved/bin:/usr/bin", SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8", HTTPS_PROXY: "http://localhost:8080", CODEX_HOME: "/home/user/.codex",
    ANTHROPIC_API_KEY: "user-key", NODE_ENV: "production", NODE_OPTIONS: "--require /muster/bootstrap.cjs",
    ELECTRON_RUN_AS_NODE: "1", ELECTRON_ENABLE_LOGGING: "1",
    MUSTER_HOME: "/muster", MUSTER_ENROLL_KEY: "private", MUSTER_PUBLIC_URL: "http://localhost:7420",
    missing: undefined,
  };
  expect(runtimeEnv(source, { ANTHROPIC_API_KEY: "granted-key", OTHER_SECRET: "secret", MUSTER_HOME: "blocked", NODE_ENV: "production" })).toEqual({
    HOME: source.HOME, PATH: source.PATH, SHELL: source.SHELL, LANG: source.LANG,
    HTTPS_PROXY: source.HTTPS_PROXY, CODEX_HOME: source.CODEX_HOME,
    ANTHROPIC_API_KEY: "granted-key", OTHER_SECRET: "secret",
  });
  expect(source.NODE_ENV).toBe("production");
  expect(source.ANTHROPIC_API_KEY).toBe("user-key");
});

it("filters worker variable names case-insensitively for Windows", () => {
  expect(runtimeEnv({ Path: "/resolved/bin", node_env: "production", muster_home: "private", Electron_Run_As_Node: "1" })).toEqual({ Path: "/resolved/bin" });
});

it("passes the sanitized environment through the runtime to its shell commands", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NODE_OPTIONS", "--no-warnings");
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  vi.stubEnv("MUSTER_ENROLL_KEY", "private");
  vi.stubEnv("MUSTER_HOME", "/muster");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  const peer = new JsonProcess(process.execPath, ["--input-type=commonjs", "-e", `
    const { execFileSync } = require('node:child_process');
    const env = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { encoding: 'utf8' }));
    console.log(JSON.stringify(env));
    setInterval(() => {}, 1000);
  `], process.cwd());
  try {
    const env = await new Promise<Record<string, string>>((resolve, reject) => {
      peer.onMessage = resolve;
      peer.onFailure = reject;
    });
    expect(env).toMatchObject({ PATH: process.env.PATH, ANTHROPIC_API_KEY: "test-key" });
    for (const key of ["NODE_ENV", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "MUSTER_ENROLL_KEY", "MUSTER_HOME"]) expect(env).not.toHaveProperty(key);
  } finally { await peer.stop(); }
});
