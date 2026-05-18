import fs from "node:fs";
import ts from "typescript";

const sourcePath = new URL("../src/index.ts", import.meta.url);
let source = fs.readFileSync(sourcePath, "utf8");
source = source.replace("function adminPage(): string {", "export function adminPage(): string {");

const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;

{
  const mod = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const html = mod.adminPage();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

  class ElementStub {
    constructor(selector) {
      this.selector = selector;
      this.value = "";
      this.textContent = "";
      this.className = "";
      this.innerHTML = "";
      this.checked = false;
      this.dataset = {};
      this.listeners = new Map();
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    querySelector() {
      return new ElementStub(`${this.selector} child`);
    }

    querySelectorAll() {
      if (this.selector === "#proxyChannelPicker") {
        return [new ElementStub("channel-a"), new ElementStub("channel-b")];
      }
      if (this.selector === "#gatewayKeyList") {
        return [new ElementStub("delete-key")];
      }
      return [];
    }

    getAttribute() {
      return null;
    }

    select() {
      this.selected = true;
    }
  }

  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, new ElementStub(selector));
    }
    return elements.get(selector);
  };

  const i18nTitle = new ElementStub("adminTitle");
  i18nTitle.getAttribute = () => "adminTitle";
  const i18nNodes = [i18nTitle];

  const document = {
    documentElement: { lang: "" },
    addEventListener(type, handler) {
      if (type === "DOMContentLoaded") handler();
    },
    querySelector: element,
    querySelectorAll(selector) {
      return selector === "[data-i18n]" ? i18nNodes : [];
    }
  };

  const localStorage = new Map();
  const window = {
    localStorage: {
      getItem(key) {
        return localStorage.get(key) || null;
      },
      setItem(key, value) {
        localStorage.set(key, value);
      }
    },
    addEventListener() {}
  };
  const navigator = {
    language: "en-US",
    clipboard: {
      async writeText(value) {
        window.copiedText = value;
      }
    }
  };

  const fetch = async (path, options = {}) => {
    if (path === "/admin/settings" && options.method === "PUT") {
      return { ok: true, status: 200, json: async () => ({ ok: true, proxyApiKeyPreview: "sk-rou...abcd" }) };
    }

    return {
      ok: true,
      status: 200,
      json: async () => {
        if (path === "/admin/channels/raw") return { channels: [] };
        if (path === "/admin/cursors") return {};
        if (path === "/admin/settings") return { source: "none", proxyApiKeyPreview: "" };
        return { ok: true };
      }
    };
  };

  for (const script of scripts.slice(0, 2)) {
    new Function("document", "window", "navigator", "fetch", "crypto", "location", script)(
      document,
      window,
      navigator,
      fetch,
      crypto,
      { href: "/admin" }
    );
  }

  window.toggleAdminLang();
  if (document.documentElement.lang !== "zh-CN") {
    throw new Error(`Language toggle failed: ${document.documentElement.lang}`);
  }

  window.generateGatewayKey();
  const generatedKey = element("#proxyApiKey").value;
  if (!generatedKey.startsWith("sk-router-") || generatedKey.length < 32) {
    throw new Error("Gateway key generation failed");
  }
  element("#copyProxyKeyBtn").listeners.get("click")();
  if (window.copiedText !== generatedKey) {
    throw new Error("Gateway key copy failed");
  }
  element("#proxyKeyName").value = "nvidia-only";
  element("#proxyKeyChannels").value = "nvidia, deepseek";

  await window.saveGatewayKey();
  if (!element("#proxyKeyStatus").textContent) {
    throw new Error("Gateway key save did not update status");
  }

  element("#editor").value = JSON.stringify([
    {
      id: "nvidia",
      name: "NVIDIA",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "same-key",
      enabled: true,
      models: ["a"]
    }
  ]);
  element("#channelBaseUrl").value = "https://integrate.api.nvidia.com/v1";
  element("#channelApiKeys").value = "same-key";
  element("#channelModels").value = "b";
  element("#generateChannelsBtn").listeners.get("click")();
  const channels = JSON.parse(element("#editor").value);
  if (channels.length !== 1 || !channels[0].models.includes("a") || !channels[0].models.includes("b")) {
    throw new Error("Existing channel model merge failed");
  }

  element("#editor").value = "[]";
  element("#channelIdPrefix").value = "nvidia";
  element("#channelBaseUrl").value = "https://example.com/v1";
  element("#channelApiKeys").value = "key-a";
  element("#channelModels").value = "model-a";
  element("#generateChannelsBtn").listeners.get("click")();
  const numberedChannels = JSON.parse(element("#editor").value);
  if (numberedChannels[0].id !== "nvidia-1") {
    throw new Error(`First generated channel should be numbered with -1, got ${numberedChannels[0].id}`);
  }

  console.log("admin runtime smoke passed");
}
