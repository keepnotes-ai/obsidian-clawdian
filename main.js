var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => OpenClawPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// ============================================
// src/secureStorage.ts — Preserved from v0.4.1
// ============================================
var safeStorage = null;
var safeStorageAvailable = null;

function getSafeStorage() {
  var _a;
  if (safeStorageAvailable === false) return null;
  if (safeStorage) return safeStorage;
  try {
    const electron = require("electron");
    if ((_a = electron == null ? void 0 : electron.remote) == null ? void 0 : _a.safeStorage) {
      safeStorage = electron.remote.safeStorage;
    } else if (electron == null ? void 0 : electron.safeStorage) {
      safeStorage = electron.safeStorage;
    }
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      safeStorageAvailable = true;
      return safeStorage;
    }
  } catch (e) {}
  safeStorageAvailable = false;
  return null;
}

function getEnvToken() {
  try {
    return process.env.OPENCLAW_TOKEN || null;
  } catch (e) {
    return null;
  }
}

var SecureTokenStorage = class {
  constructor() {
    this.encryptedToken = null;
    this.plaintextToken = "";
  }
  getActiveMethod() {
    if (getEnvToken()) return "envVar";
    if (getSafeStorage()) return "safeStorage";
    return "plaintext";
  }
  getStatusInfo() {
    if (getEnvToken()) return { method: "envVar", description: "Using OPENCLAW_TOKEN environment variable", secure: true };
    if (getSafeStorage()) return { method: "safeStorage", description: "Encrypted with OS keychain (Keychain/DPAPI/libsecret)", secure: true };
    return { method: "plaintext", description: "\u26A0\uFE0F Stored in plaintext \u2014 avoid syncing plugin folder", secure: false };
  }
  setToken(token) {
    if (getEnvToken()) return { encrypted: null, plaintext: "" };
    const storage = getSafeStorage();
    if (storage && token) {
      try {
        const encrypted = storage.encryptString(token);
        this.encryptedToken = encrypted.toString("base64");
        this.plaintextToken = "";
        return { encrypted: this.encryptedToken, plaintext: "" };
      } catch (e) {}
    }
    this.encryptedToken = null;
    this.plaintextToken = token;
    return { encrypted: null, plaintext: token };
  }
  getToken(encrypted, plaintext) {
    const envToken = getEnvToken();
    if (envToken) return envToken;
    if (encrypted) {
      const storage = getSafeStorage();
      if (storage) {
        try {
          const buffer = Buffer.from(encrypted, "base64");
          return storage.decryptString(buffer);
        } catch (e) {}
      }
    }
    return plaintext || "";
  }
  isSafeStorageAvailable() { return getSafeStorage() !== null; }
  isEnvVarSet() { return getEnvToken() !== null; }
};

var secureTokenStorage = new SecureTokenStorage();

// ============================================
// src/types.ts — Settings & Defaults
// ============================================
var DEFAULT_SETTINGS = {
  gatewayUrl: "http://127.0.0.1:18789",
  gatewayTokenEncrypted: null,
  gatewayTokenPlaintext: "",
  showActionsInChat: true,
  auditLogEnabled: false,
  auditLogPath: "Clawdian/audit-log.md",
  includeCurrentNote: true,
  conversationsPath: "Clawdian/conversations",
  // Preserved sync settings for backwards compatibility
  syncEnabled: false,
  syncServerUrl: "http://127.0.0.1:18790",
  syncPaths: [{ remotePath: "notes", localPath: "OpenClaw/Notes", enabled: true }],
  syncInterval: 0,
  syncConflictBehavior: "ask"
};

// ============================================
// src/api.ts — OpenClaw Gateway API (v2: streaming + history)
// ============================================
var OpenClawAPI = class {
  constructor(settings) {
    this.settings = settings;
  }
  getToken() {
    return secureTokenStorage.getToken(
      this.settings.gatewayTokenEncrypted,
      this.settings.gatewayTokenPlaintext
    );
  }
  /**
   * Send a chat message with full conversation history.
   * Uses Node.js http module for streaming (reliable in Electron).
   */
  async chat(messages, onChunk, abortSignal) {
    const parsedUrl = new URL(`${this.settings.gatewayUrl}/v1/chat/completions`);
    const token = this.getToken();
    const body = JSON.stringify({
      model: "clawdbot:main",
      messages: messages,
      stream: true
    });

    const http = require(parsedUrl.protocol === "https:" ? "https" : "http");

    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) { reject(new Error("AbortError")); return; }

      const req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname,
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
        }
      }, (res) => {
        if (res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (chunk) => errBody += chunk);
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        let fullText = "";
        let buffer = "";

        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                fullText += delta.content;
                if (onChunk) onChunk(fullText, delta.content);
              }
            } catch (e) {}
          }
        });

        res.on("end", () => resolve(fullText));
        res.on("error", (err) => reject(err));
      });

      req.on("error", (err) => reject(new Error(`Failed to connect: ${err.message}`)));

      // Abort support
      if (abortSignal) {
        const onAbort = () => { req.destroy(); reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })); };
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      req.write(body);
      req.end();
    });
  }

  /**
   * Non-streaming chat (for testing connection)
   */
  async chatSync(message) {
    const url = `${this.settings.gatewayUrl}/v1/chat/completions`;
    const token = this.getToken();
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clawdbot:main",
        messages: [{ role: "user", content: message }],
        stream: false
      })
    });
    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}: ${response.text}`);
    }
    return response.json?.choices?.[0]?.message?.content || "";
  }
};

// ============================================
// src/conversationStore.ts — Persistence
// ============================================
var ConversationStore = class {
  constructor(app, getSettings) {
    this.app = app;
    this.getSettings = getSettings;
    this.conversations = new Map();
  }

  generateId() {
    return "conv-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  }

  createConversation(title) {
    const id = this.generateId();
    const conv = {
      id,
      title: title || "New Chat",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.conversations.set(id, conv);
    return conv;
  }

  getConversation(id) {
    return this.conversations.get(id) || null;
  }

  deleteConversation(id) {
    this.conversations.delete(id);
    this.deleteFile(id);
  }

  updateTitle(id, title) {
    const conv = this.conversations.get(id);
    if (conv) {
      conv.title = title;
      conv.updatedAt = Date.now();
    }
  }

  addMessage(convId, role, content) {
    const conv = this.conversations.get(convId);
    if (!conv) return;
    conv.messages.push({ role, content, timestamp: Date.now() });
    conv.updatedAt = Date.now();
    // Auto-title from first user message
    if (conv.title === "New Chat" && role === "user") {
      conv.title = content.slice(0, 40) + (content.length > 40 ? "..." : "");
    }
  }

  getMessages(convId) {
    const conv = this.conversations.get(convId);
    if (!conv) return [];
    // Return in OpenAI format (no timestamps)
    return conv.messages.map(m => ({ role: m.role, content: m.content }));
  }

  getAllConversations() {
    return Array.from(this.conversations.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---- Persistence ----

  async saveConversation(id) {
    const conv = this.conversations.get(id);
    if (!conv) return;
    const settings = this.getSettings();
    const folder = settings.conversationsPath;
    const { vault } = this.app;

    await this.ensureFolder(folder);
    const filePath = `${folder}/${id}.json`;
    const data = JSON.stringify(conv, null, 2);

    const existing = vault.getAbstractFileByPath(filePath);
    if (existing instanceof import_obsidian.TFile) {
      await vault.modify(existing, data);
    } else {
      await vault.create(filePath, data);
    }
  }

  async loadAll() {
    const settings = this.getSettings();
    const folder = settings.conversationsPath;
    const { vault } = this.app;

    const folderObj = vault.getAbstractFileByPath(folder);
    if (!folderObj || !(folderObj instanceof import_obsidian.TFolder)) return;

    for (const child of folderObj.children) {
      if (child instanceof import_obsidian.TFile && child.extension === "json") {
        try {
          const raw = await vault.read(child);
          const conv = JSON.parse(raw);
          if (conv.id && conv.messages) {
            this.conversations.set(conv.id, conv);
          }
        } catch (e) {
          console.error("OpenClaw: Failed to load conversation", child.path, e);
        }
      }
    }
  }

  async deleteFile(id) {
    const settings = this.getSettings();
    const filePath = `${settings.conversationsPath}/${id}.json`;
    const { vault } = this.app;
    const file = vault.getAbstractFileByPath(filePath);
    if (file) {
      try { await vault.delete(file); } catch (e) {}
    }
  }

  async ensureFolder(path) {
    const { vault } = this.app;
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!vault.getAbstractFileByPath(current)) {
        await vault.createFolder(current);
      }
    }
  }
};

// ============================================
// src/actions.ts — File Action Executor (preserved from v0.4.1)
// ============================================
var DESTRUCTIVE_ACTIONS = ["deleteFile", "updateFile", "renameFile"];

var ConfirmActionModal = class extends import_obsidian.Modal {
  constructor(app, action, description) {
    super(app);
    this.action = action;
    this.description = description;
    this.result = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Confirm Action" });
    contentEl.createEl("p", { text: "OpenClaw wants to perform the following action:" });
    const detailsEl = contentEl.createDiv({ cls: "oc-confirm-details" });
    detailsEl.createEl("strong", { text: this.getActionLabel() });
    detailsEl.createEl("p", { text: this.description });
    if (this.action.action === "deleteFile") {
      contentEl.createDiv({ cls: "oc-confirm-warning" }).setText("\u26A0\uFE0F This action cannot be undone.");
    }
    const buttons = contentEl.createDiv({ cls: "oc-confirm-buttons" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => { this.result = false; this.close(); });
    const confirmBtn = buttons.createEl("button", { text: "Confirm", cls: "mod-cta" });
    confirmBtn.addEventListener("click", () => { this.result = true; this.close(); });
    confirmBtn.focus();
  }
  onClose() {
    this.contentEl.empty();
    if (this.resolvePromise) this.resolvePromise(this.result);
  }
  getActionLabel() {
    const labels = { deleteFile: "\uD83D\uDDD1\uFE0F Delete", updateFile: "\u270F\uFE0F Update", renameFile: "\uD83D\uDCDD Rename" };
    return labels[this.action.action] || this.action.action;
  }
  async waitForResult() {
    return new Promise(resolve => { this.resolvePromise = resolve; this.open(); });
  }
};

var ActionExecutor = class {
  constructor(app, getSettings) {
    this.app = app;
    this.getSettings = getSettings;
  }
  async execute(actions) {
    let success = 0, failed = 0, skipped = 0;
    for (const action of actions) {
      try {
        if (DESTRUCTIVE_ACTIONS.includes(action.action)) {
          const modal = new ConfirmActionModal(this.app, action, this.getDesc(action));
          if (!await modal.waitForResult()) { skipped++; await this.log(action, "skipped"); continue; }
        }
        await this.executeOne(action);
        await this.log(action, "success");
        success++;
      } catch (err) {
        await this.log(action, "failed", err instanceof Error ? err.message : String(err));
        failed++;
      }
    }
    if (success > 0) new import_obsidian.Notice(`OpenClaw: ${success} action(s) completed`);
    if (failed > 0) new import_obsidian.Notice(`OpenClaw: ${failed} action(s) failed`);
    return { success, failed, skipped };
  }
  getDesc(action) {
    if (action.action === "deleteFile") return `Delete: ${action.path}`;
    if (action.action === "updateFile") return `Replace: ${action.path}`;
    if (action.action === "renameFile") return `Rename: ${action.path} \u2192 ${action.newPath}`;
    return JSON.stringify(action);
  }
  async log(action, status, error) {
    const settings = this.getSettings();
    if (!settings.auditLogEnabled) return;
    const { vault } = this.app;
    const logPath = settings.auditLogPath;
    const ts = new Date().toISOString();
    const emoji = status === "success" ? "\u2705" : status === "failed" ? "\u274C" : "\u23ED\uFE0F";
    let entry = `\n| ${ts} | ${emoji} ${status} | \`${action.action}\` | `;
    if (action.action === "renameFile") entry += `\`${action.path}\` \u2192 \`${action.newPath}\` |`;
    else if (action.path) entry += `\`${action.path}\` |`;
    else entry += `${JSON.stringify(action)} |`;
    if (error) entry += ` ${error}`;

    let logFile = vault.getAbstractFileByPath(logPath);
    if (!logFile) {
      const folder = logPath.substring(0, logPath.lastIndexOf("/"));
      if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
      await vault.create(logPath, `# OpenClaw Audit Log\n\n| Timestamp | Status | Action | Details |\n|-----------|--------|--------|---------|` + entry);
    } else if (logFile instanceof import_obsidian.TFile) {
      const content = await vault.read(logFile);
      await vault.modify(logFile, content + entry);
    }
  }
  async executeOne(action) {
    const { vault } = this.app;
    switch (action.action) {
      case "createFile": {
        if (vault.getAbstractFileByPath(action.path)) throw new Error(`Exists: ${action.path}`);
        const folder = action.path.substring(0, action.path.lastIndexOf("/"));
        if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
        await vault.create(action.path, action.content);
        break;
      }
      case "updateFile": {
        const f = vault.getAbstractFileByPath(action.path);
        if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`);
        await vault.modify(f, action.content);
        break;
      }
      case "appendToFile": {
        const f = vault.getAbstractFileByPath(action.path);
        if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`);
        await vault.modify(f, (await vault.read(f)) + "\n" + action.content);
        break;
      }
      case "deleteFile": {
        const f = vault.getAbstractFileByPath(action.path);
        if (!f) throw new Error(`Not found: ${action.path}`);
        await vault.delete(f);
        break;
      }
      case "renameFile": {
        const f = vault.getAbstractFileByPath(action.path);
        if (!f) throw new Error(`Not found: ${action.path}`);
        await vault.rename(f, action.newPath);
        break;
      }
      case "openFile": {
        const f = vault.getAbstractFileByPath(action.path);
        if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`);
        await this.app.workspace.getLeaf().openFile(f);
        break;
      }
      default: throw new Error(`Unknown: ${action.action}`);
    }
  }
  parseActions(text) {
    const match = text.match(/```json:openclaw-actions\n([\s\S]*?)```/);
    if (!match) return [];
    try { return JSON.parse(match[1]); } catch (e) { return []; }
  }
  stripActionBlocks(text) {
    return text.replace(/```json:openclaw-actions\n[\s\S]*?```\n?/g, "").trim();
  }
};

// ============================================
// src/icons.ts — SVG Icons
// ============================================
var ICONS = {
  plus: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  settings: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
  copy: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
  check: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  chevronDown: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>',
  file: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
  trash: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>'
};

// ============================================
// src/OpenClawView.ts — Main Chat View (v2: complete rewrite)
// ============================================
var OPENCLAW_VIEW_TYPE = "openclaw-chat-view";

var OpenClawView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeConvId = null;
    this.isStreaming = false;
    this.abortController = null;
    this.autoScrollEnabled = true;
    this.streamingEl = null;
    this.streamingContentEl = null;
  }

  getViewType() { return OPENCLAW_VIEW_TYPE; }
  getDisplayText() { return "Clawdian"; }
  getIcon() { return "message-circle"; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("openclaw-container");

    // ---- Header ----
    const header = container.createDiv({ cls: "oc-header" });

    // Tab bar
    this.tabBarEl = header.createDiv({ cls: "oc-tab-bar" });

    // Header actions
    const actions = header.createDiv({ cls: "oc-header-actions" });

    const newBtn = actions.createEl("button", { cls: "oc-header-btn", attr: { "aria-label": "New Chat" } });
    newBtn.innerHTML = ICONS.plus;
    newBtn.addEventListener("click", () => this.newConversation());

    const clearBtn = actions.createEl("button", { cls: "oc-header-btn", attr: { "aria-label": "Delete Chat" } });
    clearBtn.innerHTML = ICONS.trash;
    clearBtn.addEventListener("click", () => this.deleteCurrentConversation());

    // ---- Messages ----
    const messagesWrapper = container.createDiv({ cls: "oc-messages-wrapper" });
    this.messagesEl = messagesWrapper.createDiv({ cls: "oc-messages" });
    this.welcomeEl = this.messagesEl.createDiv({ cls: "oc-welcome" });
    this.welcomeEl.createDiv({ cls: "oc-welcome-greeting", text: "\uD83E\uDD9E Hey, Zorba" });
    this.welcomeEl.createDiv({ cls: "oc-welcome-hint", text: "Enter to send, Shift+Enter for new line." });

    // Scroll to bottom button
    this.scrollBtnEl = messagesWrapper.createDiv({ cls: "oc-scroll-btn" });
    this.scrollBtnEl.innerHTML = ICONS.chevronDown;
    this.scrollBtnEl.addEventListener("click", () => this.scrollToBottom());

    // Scroll detection for auto-scroll
    this.messagesEl.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
      const atBottom = scrollHeight - scrollTop - clientHeight < 30;
      this.autoScrollEnabled = atBottom;
      this.scrollBtnEl.toggleClass("visible", !atBottom);
    });

    // ---- Input ----
    const inputContainer = container.createDiv({ cls: "oc-input-container" });
    const inputWrapper = inputContainer.createDiv({ cls: "oc-input-wrapper" });

    // Context row
    this.contextRowEl = inputWrapper.createDiv({ cls: "oc-context-row" });

    // Textarea
    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "oc-input",
      attr: { placeholder: "Message Clawdian...", rows: "1" }
    });

    // Auto-resize
    this.inputEl.addEventListener("input", () => this.autoResizeInput());

    // Enter to send, Shift+Enter for newline
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Toolbar
    const toolbar = inputWrapper.createDiv({ cls: "oc-input-toolbar" });
    const toolbarLeft = toolbar.createDiv({ cls: "oc-toolbar-left" });

    // Include current note toggle
    this.noteToggleBtn = toolbarLeft.createEl("button", {
      cls: "oc-toolbar-btn" + (this.plugin.settings.includeCurrentNote ? " active" : ""),
      attr: { "aria-label": "Include current note" }
    });
    this.noteToggleBtn.innerHTML = ICONS.file;
    this.noteToggleBtn.addEventListener("click", () => {
      this.plugin.settings.includeCurrentNote = !this.plugin.settings.includeCurrentNote;
      this.noteToggleBtn.toggleClass("active", this.plugin.settings.includeCurrentNote);
      this.plugin.saveSettings();
      this.updateContextRow();
    });

    const toolbarRight = toolbar.createDiv({ cls: "oc-toolbar-right" });
    toolbarRight.createDiv({ cls: "oc-send-hint", text: "Enter \u2192 send \u00B7 Shift+Enter \u2192 newline" });

    // ---- Initialize ----
    await this.plugin.conversationStore.loadAll();
    const convs = this.plugin.conversationStore.getAllConversations();
    if (convs.length === 0) {
      this.newConversation();
    } else {
      // Restore tabs from saved state
      const tabState = this.plugin.settings._tabState;
      if (tabState && tabState.tabs && tabState.tabs.length > 0) {
        this.openTabs = tabState.tabs.filter(id => this.plugin.conversationStore.getConversation(id));
        if (this.openTabs.length === 0) {
          this.openTabs = [convs[0].id];
        }
        const activeId = tabState.activeId;
        this.switchToConversation(this.openTabs.includes(activeId) ? activeId : this.openTabs[0]);
      } else {
        this.openTabs = [convs[0].id];
        this.switchToConversation(convs[0].id);
      }
    }

    this.updateContextRow();

    // Listen for active file changes to update context row
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateContextRow()));
  }

  async onClose() {
    // Save tab state
    if (this.openTabs) {
      this.plugin.settings._tabState = {
        tabs: this.openTabs,
        activeId: this.activeConvId
      };
      await this.plugin.saveSettings();
    }
  }

  // ---- Tab Management ----

  get openTabs() { return this._openTabs || []; }
  set openTabs(val) { this._openTabs = val; }

  renderTabs() {
    this.tabBarEl.empty();
    for (const convId of this.openTabs) {
      const conv = this.plugin.conversationStore.getConversation(convId);
      if (!conv) continue;

      const tab = this.tabBarEl.createDiv({ cls: "oc-tab" + (convId === this.activeConvId ? " active" : "") });

      const label = conv.title.length > 16 ? conv.title.slice(0, 16) + "\u2026" : conv.title;
      tab.createSpan({ text: label });

      if (this.openTabs.length > 1) {
        const closeBtn = tab.createSpan({ cls: "oc-tab-close", text: "\u00D7" });
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeTab(convId);
        });
      }

      tab.addEventListener("click", () => this.switchToConversation(convId));

      if (this.isStreaming && convId === this.activeConvId) {
        tab.addClass("streaming");
      }
    }
  }

  newConversation() {
    const conv = this.plugin.conversationStore.createConversation();
    this.openTabs = [...this.openTabs, conv.id];
    this.switchToConversation(conv.id);
  }

  closeTab(convId) {
    if (this.openTabs.length <= 1) return;
    const idx = this.openTabs.indexOf(convId);
    this.openTabs = this.openTabs.filter(id => id !== convId);
    if (this.activeConvId === convId) {
      const newIdx = Math.min(idx, this.openTabs.length - 1);
      this.switchToConversation(this.openTabs[newIdx]);
    } else {
      this.renderTabs();
    }
  }

  async deleteCurrentConversation() {
    if (!this.activeConvId) return;
    const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
    if (!conv) return;

    // Simple confirmation
    if (conv.messages.length > 0) {
      const confirmed = await new Promise(resolve => {
        const modal = new import_obsidian.Modal(this.app);
        modal.titleEl.setText("Delete conversation?");
        modal.contentEl.setText(`"${conv.title}" (${conv.messages.length} messages)`);
        const btns = modal.contentEl.createDiv({ cls: "oc-confirm-buttons" });
        btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => { resolve(false); modal.close(); });
        btns.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", () => { resolve(true); modal.close(); });
        modal.open();
      });
      if (!confirmed) return;
    }

    this.plugin.conversationStore.deleteConversation(this.activeConvId);
    this.closeTab(this.activeConvId);

    if (this.openTabs.length === 0) {
      this.newConversation();
    }
  }

  switchToConversation(convId) {
    this.activeConvId = convId;
    if (!this.openTabs.includes(convId)) {
      this.openTabs = [...this.openTabs, convId];
    }
    this.renderTabs();
    this.renderMessages();
  }

  // ---- Message Rendering ----

  renderMessages() {
    this.messagesEl.empty();
    const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
    if (!conv || conv.messages.length === 0) {
      this.welcomeEl = this.messagesEl.createDiv({ cls: "oc-welcome" });
      this.welcomeEl.createDiv({ cls: "oc-welcome-greeting", text: "\uD83E\uDD9E Hey, Zorba" });
      this.welcomeEl.createDiv({ cls: "oc-welcome-hint", text: "Enter to send, Shift+Enter for new line." });
      return;
    }

    for (const msg of conv.messages) {
      this.appendMessageEl(msg.role, msg.content);
    }
    this.scrollToBottom();
  }

  appendMessageEl(role, content) {
    // Hide welcome
    if (this.welcomeEl) {
      this.welcomeEl.style.display = "none";
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `oc-message oc-message-${role}`
    });

    const contentEl = msgEl.createDiv({ cls: "oc-message-content" });

    if (role === "assistant") {
      // Render markdown
      import_obsidian.MarkdownRenderer.render(
        this.app, content, contentEl, "", this.plugin
      );
    } else if (role === "error") {
      contentEl.createEl("code").setText(content);
    } else {
      // User message: render as text with line breaks
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        contentEl.appendText(line);
        if (i < lines.length - 1) contentEl.createEl("br");
      });
    }

    // Copy button (hover action)
    if (role === "assistant" || role === "user") {
      const actionsEl = msgEl.createDiv({ cls: "oc-message-actions" });
      const copyBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Copy" } });
      copyBtn.innerHTML = ICONS.copy;
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(content);
        copyBtn.innerHTML = ICONS.check;
        copyBtn.addClass("copied");
        setTimeout(() => {
          copyBtn.innerHTML = ICONS.copy;
          copyBtn.removeClass("copied");
        }, 1500);
      });
    }

    if (this.autoScrollEnabled) {
      this.scrollToBottom();
    }

    return msgEl;
  }

  // ---- Streaming Message ----

  startStreamingMessage() {
    if (this.welcomeEl) this.welcomeEl.style.display = "none";

    // Loading indicator
    this.streamingEl = this.messagesEl.createDiv({ cls: "oc-message oc-message-assistant" });
    this.streamingContentEl = this.streamingEl.createDiv({ cls: "oc-message-content" });

    const loadingEl = this.streamingContentEl.createDiv({ cls: "oc-loading" });
    const dots = loadingEl.createDiv({ cls: "oc-loading-dots" });
    dots.createEl("span");
    dots.createEl("span");
    dots.createEl("span");

    this.scrollToBottom();
    return this.streamingEl;
  }

  updateStreamingMessage(fullText) {
    if (!this.streamingContentEl) return;
    this.streamingContentEl.empty();
    import_obsidian.MarkdownRenderer.render(
      this.app, fullText, this.streamingContentEl, "", this.plugin
    );
    if (this.autoScrollEnabled) this.scrollToBottom();
  }

  finalizeStreamingMessage(fullText) {
    if (!this.streamingEl || !this.streamingContentEl) return;

    // Re-render final content
    this.streamingContentEl.empty();
    import_obsidian.MarkdownRenderer.render(
      this.app, fullText, this.streamingContentEl, "", this.plugin
    );

    // Add copy button
    const actionsEl = this.streamingEl.createDiv({ cls: "oc-message-actions" });
    const copyBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Copy" } });
    copyBtn.innerHTML = ICONS.copy;
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(fullText);
      copyBtn.innerHTML = ICONS.check;
      copyBtn.addClass("copied");
      setTimeout(() => { copyBtn.innerHTML = ICONS.copy; copyBtn.removeClass("copied"); }, 1500);
    });

    this.streamingEl = null;
    this.streamingContentEl = null;
  }

  // ---- Send Message ----

  async sendMessage() {
    const content = this.inputEl.value.trim();
    if (!content || this.isStreaming) return;

    this.inputEl.value = "";
    this.autoResizeInput();
    this.isStreaming = true;
    this.autoScrollEnabled = true;
    this.renderTabs(); // Show streaming indicator on tab

    const convId = this.activeConvId;
    if (!convId) return;

    // Build user message with optional context
    let userContent = content;
    if (this.plugin.settings.includeCurrentNote) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof import_obsidian.TFile && activeFile.extension === "md") {
        // Don't include conversation JSON files
        if (!activeFile.path.startsWith(this.plugin.settings.conversationsPath)) {
          const noteContent = await this.app.vault.read(activeFile);
          if (noteContent.trim()) {
            userContent += `\n\n[Currently viewing: ${activeFile.path}]\n\`\`\`\n${noteContent.slice(0, 4000)}\n\`\`\``;
          }
        }
      }
    }

    // Add to store & render
    this.plugin.conversationStore.addMessage(convId, "user", content);
    this.appendMessageEl("user", content);

    // Start streaming UI
    this.startStreamingMessage();
    this.abortController = new AbortController();

    try {
      // Build messages for API (use full content with context for the last user message)
      const history = this.plugin.conversationStore.getMessages(convId);
      // Replace last message content with the context-enriched version
      const apiMessages = history.map((m, i) => {
        if (i === history.length - 1 && m.role === "user") {
          return { role: "user", content: userContent };
        }
        return m;
      });

      const fullText = await this.plugin.api.chat(
        apiMessages,
        (text, _delta) => this.updateStreamingMessage(text),
        this.abortController.signal
      );

      // Strip action blocks before storing
      const cleanText = this.plugin.actionExecutor.stripActionBlocks(fullText);
      const actions = this.plugin.actionExecutor.parseActions(fullText);

      this.finalizeStreamingMessage(cleanText);
      this.plugin.conversationStore.addMessage(convId, "assistant", cleanText);

      // Execute file actions if any
      if (actions.length > 0) {
        await this.plugin.actionExecutor.execute(actions);
      }

      // Save conversation
      await this.plugin.conversationStore.saveConversation(convId);

    } catch (err) {
      if (err.name === "AbortError") {
        this.finalizeStreamingMessage("*(cancelled)*");
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
        }
        this.appendMessageEl("error", errMsg);
      }
    }

    this.isStreaming = false;
    this.abortController = null;
    this.renderTabs();
    this.inputEl.focus();
  }

  // ---- Helpers ----

  autoResizeInput() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + "px";
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  updateContextRow() {
    this.contextRowEl.empty();
    if (!this.plugin.settings.includeCurrentNote) {
      this.contextRowEl.removeClass("has-content");
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof import_obsidian.TFile && activeFile.extension === "md") {
      if (!activeFile.path.startsWith(this.plugin.settings.conversationsPath || "Clawdian/conversations")) {
        this.contextRowEl.addClass("has-content");
        const chip = this.contextRowEl.createDiv({ cls: "oc-context-chip" });
        chip.createSpan({ cls: "oc-context-chip-icon", text: "\uD83D\uDCC4" });
        chip.createSpan({ text: activeFile.basename });
      } else {
        this.contextRowEl.removeClass("has-content");
      }
    } else {
      this.contextRowEl.removeClass("has-content");
    }
  }
};

// ============================================
// src/settings.ts — Settings Tab (adapted)
// ============================================
var OpenClawSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Chat Settings" });

    new import_obsidian.Setting(containerEl)
      .setName("Gateway URL")
      .setDesc("URL of your OpenClaw gateway (no trailing slash)")
      .addText(text => text
        .setPlaceholder("http://127.0.0.1:18789")
        .setValue(this.plugin.settings.gatewayUrl)
        .onChange(async (val) => {
          this.plugin.settings.gatewayUrl = val.replace(/\/+$/, "");
          await this.plugin.saveSettings();
        }));

    // Token
    const statusInfo = secureTokenStorage.getStatusInfo();
    const tokenSetting = new import_obsidian.Setting(containerEl)
      .setName("Gateway Token")
      .setDesc("Authentication token for OpenClaw gateway");

    const statusEl = containerEl.createDiv({ cls: "oc-token-status" });
    const icon = statusInfo.secure ? "\uD83D\uDD12" : "\u26A0\uFE0F";
    statusEl.innerHTML = `<span class="oc-status-${statusInfo.secure ? "secure" : "insecure"}">${icon} ${statusInfo.description}</span>`;

    if (statusInfo.method === "envVar") {
      tokenSetting.addButton(btn => btn.setButtonText("Using Environment Variable").setDisabled(true));
    } else {
      const currentToken = secureTokenStorage.getToken(
        this.plugin.settings.gatewayTokenEncrypted,
        this.plugin.settings.gatewayTokenPlaintext
      );
      tokenSetting.addText(text => {
        text.setPlaceholder("Enter your token")
          .setValue(currentToken)
          .onChange(async (val) => {
            const { encrypted, plaintext } = secureTokenStorage.setToken(val);
            this.plugin.settings.gatewayTokenEncrypted = encrypted;
            this.plugin.settings.gatewayTokenPlaintext = plaintext;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
    }

    new import_obsidian.Setting(containerEl)
      .setName("Include current note")
      .setDesc("Automatically attach the focused note as context")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeCurrentNote)
        .onChange(async (val) => {
          this.plugin.settings.includeCurrentNote = val;
          await this.plugin.saveSettings();
        }));

    new import_obsidian.Setting(containerEl)
      .setName("Show file actions")
      .setDesc("Display file action indicators in chat messages")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showActionsInChat)
        .onChange(async (val) => {
          this.plugin.settings.showActionsInChat = val;
          await this.plugin.saveSettings();
        }));

    // Audit log
    containerEl.createEl("h3", { text: "Audit Log" });

    new import_obsidian.Setting(containerEl)
      .setName("Enable audit logging")
      .setDesc("Log file actions to a markdown file")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.auditLogEnabled)
        .onChange(async (val) => {
          this.plugin.settings.auditLogEnabled = val;
          await this.plugin.saveSettings();
        }));

    new import_obsidian.Setting(containerEl)
      .setName("Audit log path")
      .addText(text => text
        .setPlaceholder("Clawdian/audit-log.md")
        .setValue(this.plugin.settings.auditLogPath)
        .onChange(async (val) => {
          this.plugin.settings.auditLogPath = val || "Clawdian/audit-log.md";
          await this.plugin.saveSettings();
        }));

    // Storage
    containerEl.createEl("h3", { text: "Storage" });

    new import_obsidian.Setting(containerEl)
      .setName("Conversations folder")
      .setDesc("Where to save conversation history (relative to vault root)")
      .addText(text => text
        .setPlaceholder("Clawdian/conversations")
        .setValue(this.plugin.settings.conversationsPath)
        .onChange(async (val) => {
          this.plugin.settings.conversationsPath = val || "Clawdian/conversations";
          await this.plugin.saveSettings();
        }));

    // Test connection
    containerEl.createEl("h3", { text: "Connection Test" });
    const testContainer = containerEl.createDiv({ cls: "oc-test-container" });
    const testBtn = testContainer.createEl("button", { text: "Test Connection" });
    const testResult = testContainer.createEl("span", { cls: "oc-test-result" });

    testBtn.addEventListener("click", async () => {
      testResult.setText("Testing...");
      testResult.removeClass("oc-test-success", "oc-test-error");
      try {
        const response = await this.plugin.api.chatSync("Say 'Connected!' in one word");
        testResult.setText(`\u2713 ${response}`);
        testResult.addClass("oc-test-success");
      } catch (err) {
        testResult.setText(`\u2717 ${err instanceof Error ? err.message : "Failed"}`);
        testResult.addClass("oc-test-error");
      }
    });

    // Security info
    containerEl.createEl("h3", { text: "Security" });
    const secInfo = containerEl.createDiv({ cls: "oc-security-info" });
    secInfo.innerHTML = `
      <p><strong>Token Storage (priority order):</strong></p>
      <ol>
        <li><strong>Environment Variable</strong> \u2014 Set <code>OPENCLAW_TOKEN</code></li>
        <li><strong>OS Keychain</strong> \u2014 Keychain (macOS), DPAPI (Windows), libsecret (Linux)</li>
        <li><strong>Plaintext</strong> \u2014 Avoid syncing <code>.obsidian/plugins/obsidian-openclaw/</code></li>
      </ol>
    `;
  }
};

// ============================================
// main.ts — Plugin Entry Point
// ============================================
var OpenClawPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.api = new OpenClawAPI(this.settings);
    this.actionExecutor = new ActionExecutor(this.app, () => this.settings);
    this.conversationStore = new ConversationStore(this.app, () => this.settings);

    this.registerView(OPENCLAW_VIEW_TYPE, (leaf) => new OpenClawView(leaf, this));

    this.addRibbonIcon("message-circle", "Open Clawdian", () => this.activateView());

    this.addCommand({
      id: "open-openclaw-chat",
      name: "Open Clawdian",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "new-openclaw-chat",
      name: "New Clawdian Chat",
      callback: async () => {
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(OPENCLAW_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view;
          if (view instanceof OpenClawView) view.newConversation();
        }
      }
    });

    this.addSettingTab(new OpenClawSettingTab(this.app, this));
    console.log("Clawdian v1.0 loaded \uD83E\uDD9E");
  }

  onunload() {
    console.log("Clawdian unloaded");
  }

  async loadSettings() {
    const data = await this.loadData() || {};
    // Migration from v0.4.1
    if (data.gatewayToken && !data.gatewayTokenPlaintext && !data.gatewayTokenEncrypted) {
      data.gatewayTokenPlaintext = data.gatewayToken;
      delete data.gatewayToken;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.api = new OpenClawAPI(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = null;
    const leaves = workspace.getLeavesOfType(OPENCLAW_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: OPENCLAW_VIEW_TYPE, active: true });
      }
    }
    if (leaf) workspace.revealLeaf(leaf);
  }
};
