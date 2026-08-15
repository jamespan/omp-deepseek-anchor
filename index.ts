// dsh-anchored-standard 的 omp 移植（仅对 deepseek-v4-pro 会话生效）：
// 依据 deepseek-harness 冻结提交 47f9438 的官方源码逐字节复刻 minimal 的 wire 呈现：
// 1) 注册 str_replace_editor 工具（view/create/str_replace/insert，官方 schema/描述/输出/错误文案）；
// 2) 目标会话所有请求的 wire 层：bash 与 str_replace_editor 的工具对象替换为官方 schema（描述+参数逐字节）；
// 3) 首个模型请求 = Minimal 对齐：system 消息整体替换为官方 RL prompt 原句，
//    wire 工具目录过滤为 bootstrap 对（bash + str_replace_editor），max_tokens 对齐 256000；
// 4) bootstrap 阶段硬拦截非最小工具调用（等价 dsh 的"工具不存在"）；
// 5) 首个持久信号（首次合法工具调用 / 对话中第一条 assistant 消息）后恢复完整目录与常规 system prompt；
// 6) 非目标模型会话：从 wire 目录中移除 str_replace_editor，其余行为不变。
// 参考: https://github.com/xiaobright/dsh-anchored-standard
// 调试: ANCHORED_DEBUG=1 时把关键事件写入 /tmp/anchored-debug.jsonl
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const DEBUG_FILE = "/tmp/anchored-debug.jsonl";
// 默认只锚定 deepseek-v4-pro；ANCHORED_TARGET 可覆盖（精确匹配裸模型 id，无前缀）
const TARGET = process.env.ANCHORED_TARGET ?? "deepseek-v4-pro";
// 官方 minimal preset 的完整 system prompt（minimal-preset.snapshot.ts: "sends the exact RL prompt and schemas"）
const PERSONA = process.env.ANCHORED_PERSONA ?? "You are a helpful software engineer assistant.";
// dsh 最小对 = 持久 bash + str_replace_editor
const BOOTSTRAP_TOOLS = (process.env.ANCHORED_TOOLS ?? "bash,str_replace_editor")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const EDITOR_NAME = "str_replace_editor";
const MAX_VIEW_CHARS = 16000;
// dsh 证据条件：首请求 adapter 默认 maxTokens = 256000（可覆盖）
const MAX_TOKENS = Number(process.env.ANCHORED_MAX_TOKENS ?? "256000");

// ---------- 官方 wire 呈现（deepseek-harness 47f9438 源码逐字节） ----------

// minimal preset 对 persistent-bash 的描述覆盖（agent.cordis.yml 原样；
// 网络/镜像声明是 dsh 部署语义，与 omp 实际不同，可用 ANCHORED_BASH_DESC 覆盖）
const DSH_BASH_DESC = process.env.ANCHORED_BASH_DESC ?? `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

// tool-bash-persistent/src/index.ts 的参数 schema（仅 command 一个参数）
const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The bash command to run. Relative path is preferred in the command.",
    },
  },
  required: ["command"],
};

// tool-str-replace-editor/src/index.ts 的 DEFAULT_DESCRIPTION（.trim() 后）
const EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

// tool-str-replace-editor/src/index.ts 的参数 schema（描述逐字节）
const EDITOR_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert"],
      description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
    },
    path: {
      type: "string",
      description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
    },
    file_text: {
      type: "string",
      description: "Required parameter of `create` command, with the content of the file to be created.",
    },
    insert_line: {
      type: "integer",
      description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
    },
    new_str: {
      type: "string",
      description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
    },
    old_str: {
      type: "string",
      description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
    },
    view_range: {
      type: "array",
      items: { type: "integer" },
      description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
    },
  },
  required: ["command", "path"],
};

// ---------- 通用小工具 ----------

function roleOf(m: unknown): string | undefined {
  if (!m || typeof m !== "object" || !("role" in m)) return undefined;
  return typeof m.role === "string" ? m.role : undefined;
}

function payloadOf(event: unknown): object | undefined {
  if (!event || typeof event !== "object") return undefined;
  const p: unknown = "payload" in event ? event.payload : event;
  return p && typeof p === "object" ? p : undefined;
}

function isTargetModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const bare = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  return bare.toLowerCase() === TARGET.toLowerCase();
}

function isFunction(v: unknown): v is (...args: unknown[]) => unknown {
  return typeof v === "function";
}

function modelIdFromCtx(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const models: unknown = "models" in ctx ? ctx.models : undefined;
  if (!models || typeof models !== "object") return undefined;
  const current: unknown = "current" in models ? models.current : undefined;
  if (!isFunction(current)) return undefined;
  const model: unknown = Reflect.apply(current, models, []);
  if (!model || typeof model !== "object") return undefined;
  const id: unknown = "id" in model ? model.id : undefined;
  return typeof id === "string" ? id : undefined;
}

function toolNameOf(t: unknown): string | undefined {
  if (!t || typeof t !== "object") return undefined;
  if ("function" in t && t.function && typeof t.function === "object" && "name" in t.function) {
    return typeof t.function.name === "string" ? t.function.name : undefined;
  }
  if ("name" in t) return typeof t.name === "string" ? t.name : undefined;
  return undefined;
}

function isBootstrapTool(t: unknown): boolean {
  const name = toolNameOf(t);
  return name !== undefined && BOOTSTRAP_TOOLS.includes(name);
}

function extractBlock(text: string, tag: string): string {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  return re.exec(text)?.[0] ?? "";
}

// 从原 system 提取标记区间（起始串到结束串，结束省略则到文末）
function extractBetween(text: string, start: string, end?: string): string {
  const s = text.indexOf(start);
  if (s < 0) return "";
  const e = end === undefined ? text.length : text.indexOf(end, s + start.length);
  return text.slice(s, e < 0 ? text.length : e).trim();
}

function toolLine(t: unknown): string | undefined {
  const name = toolNameOf(t);
  if (!name || !t || typeof t !== "object") return undefined;
  let desc = "";
  if (
    "function" in t &&
    t.function &&
    typeof t.function === "object" &&
    "description" in t.function &&
    typeof t.function.description === "string"
  ) {
    desc = t.function.description;
  } else if ("description" in t && typeof t.description === "string") {
    desc = t.description;
  }
  return `- ${name}: ${desc.split("\n")[0].slice(0, 120)}`;
}

// —— 受控消融：把 omp 段逐个加回 persona 基线 ——
// ANCHORED_SECTIONS=role,conventions,... 逗号列表；ANCHORED_REWRITE=1 用 dsh 仿写变体，否则用原文
const SECTION_RANGES: Record<string, { start: string; end?: string }> = {
  role: { start: "# Engineering Principles", end: "# Skills & Rules" },
  conventions: { start: "<system-conventions>", end: "</system-conventions>" },
  urls: { start: "# Internal URLs", end: "# Tool Inventory" },
  inventory: { start: "# Tool Inventory", end: "# xd:// Tool Devices" },
  xd: { start: "# xd:// Tool Devices", end: "# General" },
  policy: { start: "# General", end: "# 1. Scope" },
  workflow: { start: "# 1. Scope", end: "<contract>" },
  contract: { start: "<contract>", end: "<personality>" },
  personality: { start: "<personality>", end: "</personality>" },
  critical: { start: "<critical>", end: "</critical>" },
  workstation: { start: "<workstation>", end: "</workstation>" },
  mcp: { start: "## MCP Tool Routes" },
};
const SECTIONS_REWRITTEN: Record<string, string> = {
  role: `## Principles
- Correctness first, then the next maintainer.
- We have agency and taste: remove code that isn't pulling its weight; prefer boring when it's called for.
- Consider what code compiles to; never allocate avoidably.
- Unexpected changes are the user's work: adapt.`,
  conventions: `## Conventions
System content may arrive in XML tags; treat it as authoritative.`,
  urls: `## Internal URLs
skill://, rule://, agent://, local://, xd:// tool devices.`,
  inventory: `## Tool Inventory
The tool catalog is in the request schema; use the right tool for the job.`,
  policy: `## Tool usage
- Prefer the specialized tool over the shell equivalent.
- Load only what is needed; read sections, not snippets.
- Reuse existing patterns; a second convention beside an existing one is a bug.
- Delegate wide unknowns to subagents; never abandon phases under scope pressure.`,
  workflow: `## Workflow
- Plan before touching files; research before editing; verify before yielding.`,
  contract: `## Delivery
- Never yield while work remains; complete means end-to-end, not "compiles".
- Never fabricate outputs; ground every claim in evidence.`,
  personality: `## Style
- Terse, evidence-first: every sentence carries a fact, a decision, or a risk.`,
  workstation: `## Environment
The workstation is a macOS arm64 machine; the current date and directory are in the request.`,
  mcp: `## MCP
MCP tools are available via their configured routes.`,
  critical: `## Continuation
We keep working until the deliverable is complete; tool results are the verification.`,
};


// 晋升后的 system：dsh standard 组装风格 —— persona 打头 + 注入上下文 + 强规则 + xd:// 设备文档 + 紧凑工具清单
function promotedSystemText(sysContent: string, toolLines: string[]): string {
  const mode = process.env.ANCHORED_PROMOTED_MODE ?? "lean";
  if (mode === "persona") {
    return [PERSONA, extractBlock(sysContent, "skills"), extractBlock(sysContent, "repo-rules")]
      .filter((s) => s.length > 0)
      .join("\n\n");
  }
  if (mode === "upstream") return PERSONA;
  if (mode === "full") return sysContent;
  const tools =
    toolLines.length > 0 && process.env.ANCHORED_TOOL_LIST !== "0"
      ? ["## Tools", ...toolLines].join("\n")
      : "";
  const parts: string[] = [
    PERSONA,
    extractBlock(sysContent, "skills"),
    extractBlock(sysContent, "repo-rules"),
  ];
  if (mode === "lean") {
    // 消融阶梯通过的最终组合：persona 打头 + 全部 omp 段（原文）+ xd:// 设备 + 工具清单；
    // 仅 <critical> 块用 dsh 仿写版（原文实测有 let_me 回归）
    const order = [
      "role", "conventions", "urls", "inventory",
      "policy", "workflow", "contract", "personality",
      "workstation", "mcp", "xd",
    ];
    for (const name of order) {
      const spec = SECTION_RANGES[name];
      if (spec) parts.push(extractBetween(sysContent, spec.start, spec.end));
    }
    parts.push(SECTIONS_REWRITTEN["critical"], tools);
  } else if (mode === "abl") {
    // 消融阶梯：persona 基线 + ANCHORED_SECTIONS 指定的 omp 段（原文或 dsh 仿写）
    const useRewrite = process.env.ANCHORED_REWRITE === "1";
    const requested = (process.env.ANCHORED_SECTIONS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const name of requested) {
      const spec = SECTION_RANGES[name];
      if (!spec) continue;
      const rewritten = SECTIONS_REWRITTEN[name];
      parts.push(
        useRewrite && rewritten
          ? rewritten
          : extractBetween(sysContent, spec.start, spec.end),
      );
    }
  }
  return parts.filter((s) => s.length > 0).join("\n\n");
}

function promotedMessages(messages: unknown[], toolLines: string[]): unknown[] {
  const sysContent = messages
    .filter((m) => roleOf(m) === "system")
    .map((m) =>
      m && typeof m === "object" && "content" in m && typeof m.content === "string"
        ? m.content
        : "",
    )
    .join("\n");
  const firstSystem = messages.find((m) => roleOf(m) === "system");
  const rest = messages.filter((m) => roleOf(m) !== "system");
  const systemMsg =
    firstSystem && typeof firstSystem === "object"
      ? { ...firstSystem, content: promotedSystemText(sysContent, toolLines) }
      : { role: "system", content: promotedSystemText(sysContent, toolLines) };
  return [systemMsg, ...rest];
}

function personaMessage(m: unknown): unknown {
  if (!m || typeof m !== "object") return m;
  if (roleOf(m) !== "system") return m;
  const content: unknown = "content" in m ? m.content : undefined;
  if (typeof content !== "string") return m;
  return { ...m, content: PERSONA };
}

// wire 层把 bash / str_replace_editor 替换为官方 schema（两种 wire 形状）
function wireTool(t: unknown): unknown {
  const name = toolNameOf(t);
  if (name !== "bash" && name !== EDITOR_NAME) return t;
  if (!t || typeof t !== "object") return t;
  const fn = name === "bash"
    ? { name: "bash", description: DSH_BASH_DESC, parameters: BASH_SCHEMA }
    : { name: EDITOR_NAME, description: EDITOR_DESCRIPTION, parameters: EDITOR_SCHEMA };
  if ("function" in t && t.function && typeof t.function === "object") {
    return { ...t, function: { ...t.function, ...fn } };
  }
  return { ...t, ...fn };
}

// ---------- str_replace_editor 实现（官方文案逐字节） ----------

const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

function maybeTruncate(content: string): string {
  return content.length <= MAX_VIEW_CHARS ? content : content.slice(0, MAX_VIEW_CHARS) + TRUNCATED_MESSAGE;
}

function formatFileView(path: string, content: string, viewRange: number[] | undefined): string {
  const allLines = content.split("\n");
  let lines = allLines;
  let initialLine = 1;
  let finalLine: number | undefined;
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
  if (viewRange !== undefined) {
    const requestedInitialLine = viewRange[0];
    const requestedFinalLine = viewRange[1];
    if (
      viewRange.length !== 2
      || requestedInitialLine === undefined
      || requestedFinalLine === undefined
      || !viewRange.every(Number.isInteger)
    ) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    initialLine = requestedInitialLine;
    finalLine = requestedFinalLine;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      );
    }
    if (finalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
      );
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
      );
    }
    lines = finalLine === -1
      ? allLines.slice(initialLine - 1)
      : allLines.slice(initialLine - 1, finalLine);
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
  }
  const numbered = lines
    .map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`)
    .join("\n");
  return maybeTruncate(`${prompt}:\n${numbered}\n`);
}

function listDirectory(path: string): string {
  const rows: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      throw new Error(String(err));
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules" || name === "__pycache__") continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        // 无法 stat 的条目按文件处理
      }
      rows.push(`${isDir ? "d" : "f"}\t${full}`);
      if (isDir && depth < 2) visit(full, depth + 1);
    }
  };
  rows.push(`d\t${path}`);
  visit(path, 1);
  rows.sort((left, right) => {
    const leftPath = left.slice(left.indexOf("\t") + 1);
    const rightPath = right.slice(right.indexOf("\t") + 1);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const listing = maybeTruncate(rows.join("\n") + "\n");
  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const match = content.indexOf(search, offset);
    if (match < 0) return offsets;
    offsets.push(match);
    offset = match + search.length;
  }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") line += 1;
      cursor += 1;
    }
    return line;
  });
}

function editorCommand(params: unknown): string {
  const obj = params && typeof params === "object" ? params : {};
  const cmd = "command" in obj && typeof obj.command === "string" ? obj.command : undefined;
  const path = "path" in obj && typeof obj.path === "string" ? obj.path : undefined;
  if (!cmd || !path) return "Error: `command` and `path` are required.";
  if (path.trim().length === 0) throw new Error("path must be a non-empty string");
  if (!path.startsWith("/")) {
    throw new Error(`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`);
  }
  const statExisting = (forCommand: "view" | "str_replace" | "insert"): boolean => {
    if (!existsSync(path)) {
      throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
    }
    if (forCommand !== "view" && statSync(path).isDirectory()) {
      throw new Error(`The path ${path} is a directory and only the \`view\` command can be used on directories`);
    }
    return true;
  };

  if (cmd === "view") {
    statExisting("view");
    const viewRange: number[] | undefined =
      "view_range" in obj && Array.isArray(obj.view_range) ? obj.view_range : undefined;
    if (statSync(path).isDirectory()) {
      if (viewRange !== undefined) {
        throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
      }
      return listDirectory(path);
    }
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(String(err));
    }
    return formatFileView(path, content, viewRange);
  }

  if (cmd === "create") {
    if (existsSync(path)) {
      throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`);
    }
    if (!("file_text" in obj) || typeof obj.file_text !== "string") {
      throw new Error("Parameter `file_text` is required for command: create");
    }
    try {
      writeFileSync(path, obj.file_text);
    } catch (err) {
      throw new Error(String(err));
    }
    return `New file created successfully at: ${path}`;
  }

  if (cmd === "str_replace") {
    statExisting("str_replace");
    const oldStr = "old_str" in obj && typeof obj.old_str === "string" ? obj.old_str : "";
    const newStr = "new_str" in obj && typeof obj.new_str === "string" ? obj.new_str : "";
    if (oldStr === undefined || oldStr === null) {
      throw new Error("Parameter `old_str` is required for command: str_replace");
    }
    if (oldStr.length === 0) {
      throw new Error("Parameter `old_str` is empty for command: str_replace");
    }
    const before = readFileSync(path, "utf8");
    const offsets = matchOffsets(before, oldStr);
    const offset = offsets[0];
    if (offset === undefined) {
      throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`);
    }
    if (offsets.length > 1) {
      const lines = lineNumbersAt(before, offsets);
      throw new Error(
        `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
      );
    }
    writeFileSync(
      path,
      before.slice(0, offset) + newStr + before.slice(offset + oldStr.length),
    );
    return `The file ${path} has been edited successfully.`;
  }

  if (cmd === "insert") {
    statExisting("insert");
    const insertLine = "insert_line" in obj && typeof obj.insert_line === "number" ? obj.insert_line : undefined;
    const newStr = "new_str" in obj && typeof obj.new_str === "string" ? obj.new_str : undefined;
    if (insertLine === undefined) throw new Error("Parameter `insert_line` is required for command: insert");
    if (newStr === undefined) throw new Error("Parameter `new_str` is required for command: insert");
    const before = readFileSync(path, "utf8");
    const lines = before.split("\n");
    if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
      throw new Error(
        `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
      );
    }
    const after = [
      ...lines.slice(0, insertLine),
      ...newStr.split("\n"),
      ...lines.slice(insertLine),
    ].join("\n");
    writeFileSync(path, after);
    return `The file ${path} has been edited successfully.`;
  }

  return `Error: unknown command \`${cmd}\`. Allowed: view, create, str_replace, insert.`;
}

// ---------- 扩展主体 ----------

export default function anchored(pi: ExtensionAPI) {
  let promoted = false;
  let disabled = false;

  function debug(event: string, payload: unknown) {
    if (!process.env.ANCHORED_DEBUG) return;
    try {
      appendFileSync(DEBUG_FILE, JSON.stringify({ t: Date.now(), event, payload }) + "\n");
    } catch {
      // 调试日志失败不阻断
    }
  }

  function setFooter(ctx: unknown, text: string | undefined) {
    if (!ctx || typeof ctx !== "object" || !("hasUI" in ctx) || !ctx.hasUI) return;
    const ui: unknown = "ui" in ctx ? ctx.ui : undefined;
    if (!ui || typeof ui !== "object") return;
    const setStatus: unknown = "setStatus" in ui ? ui.setStatus : undefined;
    if (!isFunction(setStatus)) return;
    Reflect.apply(setStatus, ui, ["anchored", text]);
  }

  function notify(ctx: unknown, text: string) {
    if (!ctx || typeof ctx !== "object" || !("hasUI" in ctx) || !ctx.hasUI) return;
    const ui: unknown = "ui" in ctx ? ctx.ui : undefined;
    if (!ui || typeof ui !== "object") return;
    const notifyFn: unknown = "notify" in ui ? ui.notify : undefined;
    if (!isFunction(notifyFn)) return;
    Reflect.apply(notifyFn, ui, [text, "info"]);
  }

  function promote(trigger: string) {
    if (promoted) return;
    promoted = true;
    debug("promote", { trigger });
  }

  pi.on("session_start", (event: unknown, ctx: unknown) => {
    setFooter(
      ctx,
      disabled
        ? "anchored: off"
        : promoted
          ? undefined
          : `bootstrap: ${BOOTSTRAP_TOOLS.join("/")}`,
    );
  });

  pi.on("session_shutdown", (event: unknown, ctx: unknown) => {
    setFooter(ctx, undefined);
  });

  pi.registerCommand("dsh-anchor", {
    description: "anchored-standard: 查看/控制两阶段锚定（status | promote | on | off）",
    handler: async (args: unknown, ctx: unknown) => {
      const arg = typeof args === "string" ? args.trim().toLowerCase() : "";
      if (arg === "promote") {
        promote("command");
        setFooter(ctx, undefined);
        notify(ctx, "[anchored] promoted: full tool catalog restored");
        return "promoted";
      }
      if (arg === "off") {
        disabled = true;
        setFooter(ctx, "anchored: off");
        return "bootstrap disabled for this session";
      }
      if (arg === "on") {
        disabled = false;
        promoted = false;
        setFooter(ctx, `bootstrap: ${BOOTSTRAP_TOOLS.join("/")}`);
        return "bootstrap re-armed";
      }
      return `phase=${promoted ? "promoted" : disabled ? "off" : "bootstrap"}; tools=${BOOTSTRAP_TOOLS.join("/")}; promoteOn=either`;
    },
  });
  pi.registerTool({
    name: EDITOR_NAME,
    label: "Str Replace Editor",
    loadMode: "essential",
    defaultInactive: false,
    description: EDITOR_DESCRIPTION,
    parameters: pi.zod.object({
      command: pi.zod.enum(["view", "create", "str_replace", "insert"]),
      path: pi.zod.string(),
      file_text: pi.zod.string().optional(),
      insert_line: pi.zod.number().optional(),
      new_str: pi.zod.string().optional(),
      old_str: pi.zod.string().optional(),
      view_range: pi.zod.array(pi.zod.number()).optional(),
    }),
    async execute(_toolCallId, params: unknown, _signal, _onUpdate, _ctx) {
      try {
        const text = editorCommand(params);
        return {
          content: [{ type: "text", text }],
          details: { ok: true },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: String(err) }],
          details: { ok: false },
        };
      }
    },
  });

  pi.on("tool_call", (event: unknown, ctx: unknown) => {
    const name: unknown =
      event && typeof event === "object" && "toolName" in event ? event.toolName : undefined;
    debug("tool_call", { name });
    const mid = modelIdFromCtx(ctx);
    const isTarget = mid !== undefined && isTargetModel(mid);
    if (!isTarget || disabled) return;
    if (!promoted && typeof name === "string" && !BOOTSTRAP_TOOLS.includes(name)) {
      debug("blocked", { name });
      return { block: true, reason: `bootstrap phase: only ${BOOTSTRAP_TOOLS.join(", ")} available (tried ${name})` };
    }
    promote("tool_call");
    setFooter(ctx, undefined);
  });

  pi.on("before_provider_request", (event: unknown, ctx: unknown) => {
    const payload = payloadOf(event);
    if (!payload) return;
    const model: unknown = "model" in payload ? payload.model : undefined;
    const tools: unknown = "tools" in payload ? payload.tools : undefined;

    if (!isTargetModel(model)) {
      // 非目标模型：从 wire 目录移除我们注册的编辑器，其余原样
      if (Array.isArray(tools) && tools.some((t) => toolNameOf(t) === EDITOR_NAME)) {
        const out: Record<string, unknown> = {
          ...payload,
          tools: tools.filter((t) => toolNameOf(t) !== EDITOR_NAME),
        };
        return out;
      }
      return;
    }
    if (disabled) return; // /dsh-anchor off：本会话完全放行

    // 目标会话：所有请求的 wire 层把 bash / str_replace_editor 替换为官方 schema
    const out: Record<string, unknown> = { ...payload };
    if (Array.isArray(tools)) out.tools = tools.map(wireTool);

    const messages: unknown = "messages" in payload ? payload.messages : undefined;
    const input: unknown = "input" in payload ? payload.input : undefined;
    const conv = Array.isArray(messages) ? messages : Array.isArray(input) ? input : undefined;

    // 对话中已出现 assistant 消息（第二条请求、resume、纯文本首回复之后）=> 已升级
    if (!promoted && conv && conv.some((m) => roleOf(m) === "assistant")) {
      promote("assistant-message");
      setFooter(ctx, undefined);
    }
    if (promoted) {
      // dsh anchored-standard：晋升后 system 重建 ——
      // upstream：persona 全程为 system，原 omp 上下文整体转为 user 消息（对齐 pi 移植的 personaScope=always）
      // 其他模式：dsh standard 组装风格（persona 打头 + 注入 + 原文段 + 工具清单）
      const mode = process.env.ANCHORED_PROMOTED_MODE ?? "lean";
      const instructions: unknown = "instructions" in payload ? payload.instructions : undefined;
      const toolLines = Array.isArray(tools)
        ? tools.map(toolLine).filter((s): s is string => s !== undefined)
        : [];
      if (mode === "upstream") {
        const contextText =
          typeof instructions === "string" && instructions !== PERSONA ? instructions : "";
        if (typeof instructions === "string") out.instructions = PERSONA;
        const input = "input" in payload ? payload.input : undefined;
        if (contextText && Array.isArray(input)) {
          out.input = [
            { role: "user", content: [{ type: "input_text", text: contextText }] },
            ...input,
          ];
        }
        if (Array.isArray(messages)) {
          const sysText = messages
            .filter((m) => roleOf(m) === "system")
            .map((m) =>
              m && typeof m === "object" && "content" in m && typeof m.content === "string"
                ? m.content
                : "",
            )
            .join("\n");
          const replaced = promotedMessages(messages, []);
          if (sysText && sysText !== PERSONA) {
            out.messages = [
              replaced[0],
              { role: "user", content: sysText },
              ...replaced.slice(1),
            ];
          } else {
            out.messages = replaced;
          }
        }
      } else {
        if (typeof instructions === "string") {
          out.instructions = promotedSystemText(instructions, toolLines);
        }
        if (Array.isArray(messages)) out.messages = promotedMessages(messages, toolLines);
      }
      debug("promoted-pass", { model, mode });
      return out;
    }

    // 首个请求：Minimal 对齐 —— system -> persona，工具目录 -> bootstrap 对，max_tokens -> 256000
    const instructions: unknown = "instructions" in payload ? payload.instructions : undefined;
    if (Array.isArray(tools)) out.tools = tools.filter(isBootstrapTool).map(wireTool);
    if (typeof instructions === "string") out.instructions = PERSONA;
    if (Array.isArray(messages)) out.messages = messages.map(personaMessage);
    if ("max_tokens" in out) out.max_tokens = MAX_TOKENS;
    if ("max_output_tokens" in out) out.max_output_tokens = MAX_TOKENS;

    debug("anchored", {
      model,
      persona: PERSONA,
      maxTokens: "max_tokens" in out ? out.max_tokens : undefined,
      toolsBefore: Array.isArray(tools) ? tools.map(toolNameOf) : undefined,
      toolsAfter: Array.isArray(out.tools) ? out.tools.map(toolNameOf) : undefined,
      sysLens: Array.isArray(out.messages)
        ? out.messages.map((m: unknown) =>
            m && typeof m === "object" && "content" in m && typeof m.content === "string"
              ? m.content.length
              : undefined,
          )
        : undefined,
    });
    return out;
  });
}
