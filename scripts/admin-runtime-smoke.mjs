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
      { language: "en-US" },
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

  await window.saveGatewayKey();
  if (!element("#proxyKeyStatus").textContent) {
    throw new Error("Gateway key save did not update status");
  }

  console.log("admin runtime smoke passed");
}
