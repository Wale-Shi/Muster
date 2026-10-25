// Coding-agent CLIs a daemon can drive. Each runs the vendor's own harness and
// sign-in on the machine; Muster only appends instructions, MCP tools and secrets.
export type RuntimeProtocol = "codex" | "claude" | "pi" | "acp" | "mock";

export interface RuntimeInfo {
  id: string;
  label: string;
  /** Executables to look for, in order (the first found wins). */
  commands: readonly string[];
  /** Arguments that start the CLI's machine protocol. */
  args: readonly string[];
  protocol: RuntimeProtocol;
  /** `default` lets the CLI pick its own configured model. */
  defaultModel: string;
  install: string;
}

/** Model value meaning "do not pass a model; use the CLI's own default". */
export const CLI_DEFAULT_MODEL = "default";

export const RUNTIMES = [
  { id: "codex", label: "Codex", commands: ["codex"], args: ["app-server"], protocol: "codex", defaultModel: "gpt-6.1-sol", install: "npm i -g @openai/codex" },
  { id: "claude", label: "Claude Code", commands: ["claude"], args: [], protocol: "claude", defaultModel: "claude-sonnet-5-5", install: "https://claude.com/claude-code" },
  { id: "pi", label: "pi", commands: ["pi"], args: ["--mode", "rpc"], protocol: "pi", defaultModel: CLI_DEFAULT_MODEL, install: "npm i -g @mariozechner/pi-coding-agent" },
  { id: "omp", label: "omp", commands: ["omp"], args: ["--mode", "rpc"], protocol: "pi", defaultModel: CLI_DEFAULT_MODEL, install: "curl -fsSL https://omp.sh/install | sh" },
  { id: "gemini", label: "Gemini CLI", commands: ["gemini"], args: ["--acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "npm i -g @google/gemini-cli" },
  { id: "opencode", label: "OpenCode", commands: ["opencode"], args: ["acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "curl -fsSL https://opencode.ai/install | bash" },
  { id: "qwen", label: "Qwen Code", commands: ["qwen"], args: ["--acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "npm i -g @qwen-code/qwen-code" },
  { id: "devin", label: "Devin", commands: ["devin"], args: ["acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "curl -fsSL https://cli.devin.ai/install.sh | bash" },
  { id: "cline", label: "Cline", commands: ["cline"], args: ["--acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "npm i -g cline" },
  { id: "dsh", label: "dsh (DeepSeek)", commands: ["dsh"], args: ["--profile", "acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "npm i -g @deepseek-ai/dsh" },
  { id: "hermes", label: "Hermes Agent", commands: ["hermes"], args: ["acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash" },
  { id: "openclaw", label: "OpenClaw", commands: ["openclaw"], args: ["acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "npm i -g openclaw" },
  { id: "kiro", label: "Kiro CLI", commands: ["kiro-cli"], args: ["acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "curl -fsSL https://cli.kiro.dev/install | bash" },
  { id: "auggie", label: "Auggie", commands: ["auggie"], args: ["--acp"], protocol: "acp", defaultModel: CLI_DEFAULT_MODEL, install: "npm i -g @augmentcode/auggie" },
  { id: "mock", label: "Mock", commands: [], args: [], protocol: "mock", defaultModel: "mock", install: "" },
] as const satisfies readonly RuntimeInfo[];

export type Runtime = (typeof RUNTIMES)[number]["id"];
export const RUNTIME_IDS = RUNTIMES.map((runtime) => runtime.id) as [Runtime, ...Runtime[]];
export const runtimeInfo = (id: Runtime): RuntimeInfo => RUNTIMES.find((runtime) => runtime.id === id)!;
/** Environment variable that points the daemon at a runtime's executable. */
export const runtimeBinEnv = (id: Runtime): string => `MUSTER_${id.toUpperCase()}_BIN`;
