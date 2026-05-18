type Env = {
  CHANNEL_STORE: KVNamespace;
  MAX_ATTEMPTS?: string;
  ADMIN_TOKEN?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  PROXY_API_KEY?: string;
};

type Channel = {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  models?: string[];
};

type ChannelCheck = {
  id: string;
  name?: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
};

const CHANNELS_KV = "router:channels";
const CURSOR_PREFIX = "router:cursor:";
const ADMIN_KV = "router:admin";
const RETRY_STATUSES = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/" && request.method === "GET") {
      return html(homePage());
    }

    if (url.pathname === "/health") {
      return withCors(json({ ok: true, service: "multi-channel-openai-router" }));
    }

    if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
      if (!(await isAdminConfigured(env))) {
        return Response.redirect(`${url.origin}/admin/setup`, 302);
      }

      if (!(await isAdminAuthorized(request, env))) {
        return Response.redirect(`${url.origin}/admin/login`, 302);
      }

      return html(adminPage());
    }

    if (url.pathname === "/admin/login" && request.method === "GET") {
      if (!(await isAdminConfigured(env))) {
        return Response.redirect(`${url.origin}/admin/setup`, 302);
      }

      if (await isAdminAuthorized(request, env)) {
        return Response.redirect(`${url.origin}/admin`, 302);
      }

      return html(authPage("login"));
    }

    if (url.pathname === "/admin/setup" && request.method === "GET") {
      if (await isAdminConfigured(env)) {
        return Response.redirect(`${url.origin}/admin/login`, 302);
      }

      return html(authPage("setup"));
    }

    if (url.pathname.startsWith("/admin/")) {
      return withCors(await handleAdmin(request, env, url));
    }

    if (!url.pathname.startsWith("/v1/")) {
      return withCors(json({ error: "Not found" }, 404));
    }

    if (!isProxyAuthorized(request, env)) {
      return withCors(json({ error: "Unauthorized" }, 401));
    }

    return withCors(await proxyToChannel(request, env, url));
  }
};

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/admin/login" && request.method === "POST") {
    return loginAdmin(request, env, url);
  }

  if (url.pathname === "/admin/logout" && request.method === "POST") {
    return logoutAdmin(url);
  }

  if (!(await isAdminAuthorized(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (url.pathname === "/admin/channels/raw" && request.method === "GET") {
    const channels = await getChannels(env);
    return json({ count: channels.length, channels });
  }

  if (url.pathname === "/admin/channels/check" && request.method === "POST") {
    const channels = await getChannels(env);
    const results = await Promise.all(channels.map((channel) => checkChannel(channel)));
    return json({
      ok: results.every((result) => result.ok),
      count: results.length,
      results
    });
  }

  if ((url.pathname === "/admin/channels" || url.pathname === "/admin/providers") && request.method === "GET") {
    const channels = await getChannels(env);
    return json({ count: channels.length, channels: channels.map(maskChannel) });
  }

  if ((url.pathname === "/admin/channels" || url.pathname === "/admin/providers") && request.method === "PUT") {
    const body = await request.json<{ channels?: unknown; providers?: unknown }>().catch(() => null);
    const rawChannels = body?.channels ?? body?.providers;

    if (!Array.isArray(rawChannels)) {
      return json({ error: "Expected JSON body: { \"channels\": [...] }" }, 400);
    }

    const channels = normalizeChannels(rawChannels);
    if (channels.length === 0) {
      return json({ error: "At least one valid channel is required" }, 400);
    }

    await env.CHANNEL_STORE.put(CHANNELS_KV, JSON.stringify(channels));
    await resetCursors(env);
    return json({ ok: true, count: channels.length, channels: channels.map(maskChannel) });
  }

  if (url.pathname === "/admin/cursors" && request.method === "GET") {
    const channels = await getChannels(env);
    const cursors = await Promise.all(
      cursorScopes(channels).map(async (scope) => [scope, Number(await env.CHANNEL_STORE.get(cursorKey(scope))) || 0])
    );
    return json(Object.fromEntries(cursors));
  }

  return json({ error: "Not found" }, 404);
}

async function loginAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return json({ error: "ADMIN_USERNAME and ADMIN_PASSWORD are not configured" }, 503);
  }

  const body = await request.json<{ username?: unknown; password?: unknown }>().catch(() => null);
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return json({ error: "Expected JSON body: { \"username\": \"...\", \"password\": \"...\" }" }, 400);
  }

  if (body.username !== env.ADMIN_USERNAME || body.password !== env.ADMIN_PASSWORD) {
    return json({ error: "Invalid username or password" }, 401);
  }

  const token = await createAdminSession(env);
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", sessionCookie(token, url, 86400));
  return new Response(JSON.stringify({ ok: true }, null, 2), { headers });
}

function logoutAdmin(url: URL): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", sessionCookie("", url, 0));
  return new Response(JSON.stringify({ ok: true }, null, 2), { headers });
}

async function checkChannel(channel: Channel): Promise<ChannelCheck> {
  const started = Date.now();
  const modelsUrl = `${channel.baseUrl.replace(/\/+$/, "")}/models`;

  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${channel.apiKey}`,
        Accept: "application/json"
      }
    });

    await response.body?.cancel();
    return {
      id: channel.id,
      name: channel.name,
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      error: response.ok ? undefined : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      id: channel.id,
      name: channel.name,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Request failed"
    };
  }
}

async function proxyToChannel(request: Request, env: Env, inputUrl: URL): Promise<Response> {
  const body = await getReusableBody(request);
  const requestedModel = extractRequestedModel(request, body);
  const channels = selectChannels(await getChannels(env), requestedModel);

  if (channels.length === 0) {
    return json({ error: "No enabled channels match this request", model: requestedModel }, 503);
  }

  const scope = requestedModel || "default";
  const startIndex = await reserveNextIndex(env, scope, channels.length);
  const maxAttempts = Math.max(1, Math.min(parseInt(env.MAX_ATTEMPTS || "3", 10) || 3, channels.length));
  const tried: string[] = [];
  let lastStatus = 502;
  let lastError = "Upstream request failed";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const channel = channels[(startIndex + attempt) % channels.length];
    tried.push(channel.id);

    try {
      const upstreamResponse = await fetch(buildUpstreamRequest(request, inputUrl, channel, body));

      if (!RETRY_STATUSES.has(upstreamResponse.status) || attempt === maxAttempts - 1) {
        return annotateResponse(upstreamResponse, channel, attempt + 1);
      }

      lastStatus = upstreamResponse.status;
      lastError = `Upstream returned ${upstreamResponse.status}`;
      await upstreamResponse.body?.cancel();
    } catch (error) {
      lastStatus = 502;
      lastError = error instanceof Error ? error.message : "Upstream fetch failed";
    }
  }

  return json({ error: lastError, triedChannels: tried }, lastStatus);
}

function buildUpstreamRequest(request: Request, inputUrl: URL, channel: Channel, body: ArrayBuffer | null): Request {
  const baseUrl = channel.baseUrl.replace(/\/+$/, "");
  const upstreamUrl = new URL(`${baseUrl}${inputUrl.pathname.replace(/^\/v1/, "")}${inputUrl.search}`);
  const headers = new Headers(request.headers);

  headers.set("Authorization", `Bearer ${channel.apiKey}`);
  headers.delete("Host");
  headers.delete("Content-Length");
  headers.delete("CF-Connecting-IP");
  headers.delete("X-Forwarded-For");
  headers.delete("X-Real-IP");

  return new Request(upstreamUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual"
  });
}

async function getReusableBody(request: Request): Promise<ArrayBuffer | null> {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }

  return request.arrayBuffer();
}

function extractRequestedModel(request: Request, body: ArrayBuffer | null): string | null {
  if (!body || !request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown };
    return typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : null;
  } catch {
    return null;
  }
}

async function getChannels(env: Env): Promise<Channel[]> {
  const raw = await env.CHANNEL_STORE.get(CHANNELS_KV);
  if (!raw) {
    return [];
  }

  return normalizeChannels(JSON.parse(raw) as unknown);
}

function selectChannels(channels: Channel[], requestedModel: string | null): Channel[] {
  return channels.filter((channel) => {
    if (channel.enabled === false) {
      return false;
    }

    if (!requestedModel || !channel.models || channel.models.length === 0) {
      return true;
    }

    return channel.models.includes(requestedModel);
  });
}

function normalizeChannels(value: unknown): Channel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const raw = item as Record<string, unknown>;
    const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
    const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
    if (!baseUrl || !apiKey) {
      return [];
    }

    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `channel-${index + 1}`;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const models = Array.isArray(raw.models)
      ? raw.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
      : undefined;

    return [{ id, name, baseUrl, apiKey, enabled, models }];
  });
}

async function reserveNextIndex(env: Env, scope: string, channelCount: number): Promise<number> {
  const key = cursorKey(scope);
  const current = Number(await env.CHANNEL_STORE.get(key)) || 0;
  const next = (current + 1) % channelCount;
  await env.CHANNEL_STORE.put(key, String(next));
  return current % channelCount;
}

async function resetCursors(env: Env): Promise<void> {
  await env.CHANNEL_STORE.put(cursorKey("default"), "0");
}

function cursorScopes(channels: Channel[]): string[] {
  const scopes = new Set(["default"]);
  for (const channel of channels) {
    for (const model of channel.models || []) {
      scopes.add(model);
    }
  }

  return [...scopes];
}

function cursorKey(scope: string): string {
  return `${CURSOR_PREFIX}${scope}`;
}

function isProxyAuthorized(request: Request, env: Env): boolean {
  if (!env.PROXY_API_KEY) {
    return true;
  }

  return bearerToken(request) === env.PROXY_API_KEY;
}

async function isAdminAuthorized(request: Request, env: Env): Promise<boolean> {
  if (env.ADMIN_TOKEN && bearerToken(request) === env.ADMIN_TOKEN) {
    return true;
  }

  return verifyAdminSession(cookieValue(request, "admin_session"), env);
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=") || null;
    }
  }

  return null;
}

async function createAdminSession(env: Env): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + 86400;
  const payload = base64UrlEncode(JSON.stringify({ exp: expiresAt }));
  const signature = await hmac(payload, sessionSecret(env));
  return `${payload}.${signature}`;
}

async function verifyAdminSession(token: string | null, env: Env): Promise<boolean> {
  if (!token) {
    return false;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return false;
  }

  const expected = await hmac(payload, sessionSecret(env));
  if (signature !== expected) {
    return false;
  }

  try {
    const data = JSON.parse(base64UrlDecode(payload)) as { exp?: unknown };
    return typeof data.exp === "number" && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function sessionSecret(env: Env): string {
  return env.ADMIN_SESSION_SECRET || env.ADMIN_TOKEN || env.ADMIN_PASSWORD || "change-me";
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new TextDecoder().decode(bytes);
}

function sessionCookie(value: string, url: URL, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `admin_session=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

function annotateResponse(response: Response, channel: Channel, attempts: number): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Upstream-Channel", channel.id);
  headers.set("X-Upstream-Attempts", String(attempts));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function maskChannel(channel: Channel): Omit<Channel, "apiKey"> & { apiKey: string } {
  return {
    ...channel,
    apiKey: maskSecret(channel.apiKey)
  };
}

function maskSecret(secret: string): string {
  if (secret.length <= 10) {
    return "***";
  }

  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function html(markup: string): Response {
  return new Response(markup, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function adminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Channel Router Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #667085;
      --line: #d9deea;
      --accent: #186ade;
      --accent-strong: #0f4fb3;
      --danger: #c93535;
      --ok: #16845b;
      --shadow: 0 16px 40px rgba(31, 42, 68, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    header {
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.9);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 2;
    }

    .header-inner {
      max-width: 1180px;
      margin: 0 auto;
      padding: 18px 22px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 18px;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 750;
      letter-spacing: 0;
    }

    .subtle {
      color: var(--muted);
      font-size: 13px;
    }

    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 24px 22px 42px;
      display: grid;
      grid-template-columns: minmax(260px, 330px) minmax(0, 1fr);
      gap: 18px;
    }

    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .panel {
      padding: 18px;
    }

    .stack {
      display: grid;
      gap: 14px;
      align-content: start;
    }

    .row {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }

    label {
      display: grid;
      gap: 7px;
      color: var(--text);
      font-size: 13px;
      font-weight: 650;
    }

    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--text);
      font: inherit;
      outline: none;
    }

    input,
    select {
      height: 40px;
      padding: 0 11px;
    }

    textarea {
      min-height: 470px;
      padding: 14px;
      resize: vertical;
      font: 13px/1.55 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      tab-size: 2;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(24, 106, 222, 0.12);
    }

    button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--text);
      padding: 0 13px;
      font: 650 13px/1 Inter, ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }

    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }

    button.primary:hover {
      background: var(--accent-strong);
    }

    button:hover {
      border-color: #b8c1d4;
    }

    .status {
      min-height: 38px;
      padding: 9px 11px;
      border-radius: 7px;
      background: #f2f5fa;
      color: var(--muted);
      font-size: 13px;
    }

    .status.ok {
      background: #eaf7f1;
      color: var(--ok);
    }

    .status.error {
      background: #fff0f0;
      color: var(--danger);
    }

    .summary {
      display: grid;
      gap: 10px;
    }

    .metric {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
    }

    .metric:last-child {
      border-bottom: 0;
    }

    .metric b {
      font-size: 18px;
    }

    .table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 620px;
    }

    th,
    td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
      text-transform: uppercase;
    }

    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      color: #344054;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 0 9px;
      background: #eef4ff;
      color: #175cd3;
      font-size: 12px;
      font-weight: 700;
    }

    .badge.off {
      background: #f2f4f7;
      color: #667085;
    }

    .badge.ok {
      background: #eaf7f1;
      color: var(--ok);
    }

    .badge.error {
      background: #fff0f0;
      color: var(--danger);
    }

    @media (max-width: 820px) {
      .header-inner {
        align-items: flex-start;
        flex-direction: column;
      }

      main {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 520px) {
      .panel > .row {
        align-items: stretch;
        flex-direction: column;
      }

      .panel > .row button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div>
        <h1 data-i18n="adminTitle">Multi-channel Router Admin</h1>
        <div class="subtle" data-i18n="adminSub">Manage OpenAI-compatible channels stored in Workers KV.</div>
      </div>
      <div class="row">
        <button id="adminLangBtn" type="button">中文 / EN</button>
        <button id="healthBtn" type="button" data-i18n="checkHealth">Check health</button>
      </div>
    </div>
  </header>

  <main>
    <div class="stack">
      <section class="panel stack">
        <label>
          <span data-i18n="username">Username</span>
          <input id="username" type="text" autocomplete="username" placeholder="ADMIN_USERNAME">
        </label>
        <label>
          <span data-i18n="password">Password</span>
          <input id="password" type="password" autocomplete="current-password" placeholder="ADMIN_PASSWORD">
        </label>
        <div class="row">
          <button id="loginBtn" class="primary" type="button" data-i18n="login">Login</button>
          <button id="logoutBtn" type="button" data-i18n="logout">Logout</button>
        </div>
        <button id="loadBtn" type="button" data-i18n="loadConfig">Load config</button>
        <div id="status" class="status" data-i18n="loginHint">Login with ADMIN_USERNAME and ADMIN_PASSWORD, then load the current channel config.</div>
      </section>

      <section class="panel summary">
        <div class="metric">
          <span class="subtle" data-i18n="channels">Channels</span>
          <b id="channelCount">0</b>
        </div>
        <div class="metric">
          <span class="subtle" data-i18n="enabled">Enabled</span>
          <b id="enabledCount">0</b>
        </div>
        <div class="metric">
          <span class="subtle" data-i18n="cursorScopes">Cursor scopes</span>
          <b id="cursorCount">0</b>
        </div>
      </section>
    </div>

    <div class="stack">
      <section class="panel stack">
        <div class="row">
          <div>
            <h2 style="margin:0;font-size:16px;" data-i18n="channelJson">Channel JSON</h2>
            <div class="subtle" data-i18n="channelJsonHint">Edit the full channel array. Saving resets the default cursor.</div>
          </div>
          <button id="saveBtn" class="primary" type="button" data-i18n="saveChannels">Save channels</button>
        </div>
        <textarea id="editor" spellcheck="false">[
  {
    "id": "nvidia",
    "name": "NVIDIA",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "apiKey": "nvapi-xxx",
    "enabled": true,
    "models": ["meta/llama-3.1-70b-instruct"]
  }
]</textarea>
        <div class="row">
          <label style="flex:1;">
            <span data-i18n="templateLabel">Channel template</span>
            <select id="templateSelect"></select>
          </label>
          <button id="appendTemplateBtn" type="button" data-i18n="appendTemplate">Append template</button>
        </div>
      </section>

      <section class="panel stack">
        <div class="row">
          <h2 style="margin:0;font-size:16px;" data-i18n="channels">Channels</h2>
          <div class="row" style="justify-content:flex-end;">
            <button id="checkChannelsBtn" type="button" data-i18n="checkChannels">Check channels</button>
            <button id="refreshBtn" type="button" data-i18n="refresh">Refresh</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-i18n="id">ID</th>
                <th data-i18n="baseUrl">Base URL</th>
                <th data-i18n="models">Models</th>
                <th data-i18n="status">Status</th>
                <th data-i18n="check">Check</th>
              </tr>
            </thead>
            <tbody id="channelRows">
              <tr><td colspan="5" class="subtle" data-i18n="noData">No data loaded.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel stack">
        <div class="row">
          <h2 style="margin:0;font-size:16px;" data-i18n="cursors">Cursors</h2>
          <span class="subtle" data-i18n="cursorsHint">Per model round-robin position</span>
        </div>
        <pre id="cursors" class="status" style="white-space:pre-wrap;margin:0;">{}</pre>
      </section>
    </div>
  </main>

  <script>
    const usernameInput = document.querySelector("#username");
    const passwordInput = document.querySelector("#password");
    const editor = document.querySelector("#editor");
    const statusBox = document.querySelector("#status");
    const channelRows = document.querySelector("#channelRows");
    const cursorsBox = document.querySelector("#cursors");
    const channelCount = document.querySelector("#channelCount");
    const enabledCount = document.querySelector("#enabledCount");
    const cursorCount = document.querySelector("#cursorCount");
    const templateSelect = document.querySelector("#templateSelect");
    let checkResults = {};
    const channelTemplates = [
      {
        id: "openai",
        label: "OpenAI",
        channel: { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["gpt-4.1-mini"] }
      },
      {
        id: "nvidia",
        label: "NVIDIA NIM",
        channel: { id: "nvidia", name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["meta/llama-3.1-70b-instruct"] }
      },
      {
        id: "openrouter",
        label: "OpenRouter",
        channel: { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["openai/gpt-4o-mini"] }
      },
      {
        id: "deepseek",
        label: "DeepSeek",
        channel: { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["deepseek-chat"] }
      },
      {
        id: "groq",
        label: "Groq",
        channel: { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["llama-3.1-8b-instant"] }
      },
      {
        id: "together",
        label: "Together AI",
        channel: { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"] }
      },
      {
        id: "siliconflow",
        label: "SiliconFlow",
        channel: { id: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["Qwen/Qwen2.5-7B-Instruct"] }
      },
      {
        id: "moonshot",
        label: "Moonshot",
        channel: { id: "moonshot", name: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["moonshot-v1-8k"] }
      },
      {
        id: "dashscope",
        label: "Alibaba DashScope",
        channel: { id: "dashscope", name: "Alibaba DashScope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: ["qwen-plus"] }
      },
      {
        id: "custom",
        label: "Custom OpenAI-compatible",
        channel: { id: "custom", name: "Custom", baseUrl: "https://example.com/v1", apiKey: "REPLACE_WITH_API_KEY", enabled: true, models: [] }
      }
    ];
    const adminMessages = {
      en: {
        adminTitle: "Multi-channel Router Admin",
        adminSub: "Manage OpenAI-compatible channels stored in Workers KV.",
        checkHealth: "Check health",
        username: "Username",
        password: "Password",
        login: "Login",
        logout: "Logout",
        loadConfig: "Load config",
        loginHint: "Login with ADMIN_USERNAME and ADMIN_PASSWORD, then load the current channel config.",
        channels: "Channels",
        enabled: "Enabled",
        cursorScopes: "Cursor scopes",
        channelJson: "Channel JSON",
        channelJsonHint: "Edit the full channel array. Saving resets the default cursor.",
        templateLabel: "Channel template",
        appendTemplate: "Append template",
        saveChannels: "Save channels",
        checkChannels: "Check channels",
        refresh: "Refresh",
        id: "ID",
        baseUrl: "Base URL",
        models: "Models",
        status: "Status",
        check: "Check",
        noData: "No data loaded.",
        noChannels: "No channels configured.",
        cursors: "Cursors",
        cursorsHint: "Per model round-robin position",
        notChecked: "not checked",
        enabledBadge: "enabled",
        disabledBadge: "disabled",
        ok: "ok",
        failed: "failed",
        loggedIn: "Logged in.",
        loggedOut: "Logged out.",
        loaded: "Configuration loaded.",
        saved: "Channels saved.",
        checking: "Checking channels...",
        allAvailable: "All channels are available.",
        someFailed: "Some channels failed the availability check.",
        healthOk: "Worker health check passed.",
        healthBad: "Health check returned unexpected data.",
        templateAdded: "Template appended. Review the API key and model list, then save.",
        invalidJson: "Editor must contain a JSON array."
      },
      zh: {
        adminTitle: "多渠道路由后台",
        adminSub: "管理保存在 Workers KV 中的 OpenAI-compatible 渠道。",
        checkHealth: "健康检查",
        username: "账号",
        password: "密码",
        login: "登录",
        logout: "退出",
        loadConfig: "加载配置",
        loginHint: "使用 ADMIN_USERNAME 和 ADMIN_PASSWORD 登录，然后加载渠道配置。",
        channels: "渠道",
        enabled: "启用",
        cursorScopes: "游标范围",
        channelJson: "渠道 JSON",
        channelJsonHint: "编辑完整渠道数组。保存后会重置默认游标。",
        templateLabel: "渠道模板",
        appendTemplate: "追加模板",
        saveChannels: "保存渠道",
        checkChannels: "检测渠道",
        refresh: "刷新",
        id: "ID",
        baseUrl: "Base URL",
        models: "模型",
        status: "状态",
        check: "检测",
        noData: "还没有加载数据。",
        noChannels: "还没有配置渠道。",
        cursors: "游标",
        cursorsHint: "每个模型的轮询位置",
        notChecked: "未检测",
        enabledBadge: "已启用",
        disabledBadge: "已停用",
        ok: "正常",
        failed: "失败",
        loggedIn: "已登录。",
        loggedOut: "已退出。",
        loaded: "配置已加载。",
        saved: "渠道已保存。",
        checking: "正在检测渠道...",
        allAvailable: "所有渠道可用。",
        someFailed: "部分渠道检测失败。",
        healthOk: "Worker 健康检查通过。",
        healthBad: "健康检查返回异常。",
        templateAdded: "模板已追加。请检查 API Key 和模型列表，然后保存。",
        invalidJson: "编辑器内容必须是 JSON 数组。"
      }
    };
    let adminLang = localStorage.getItem("routerLang") || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");

    function t(key) {
      return adminMessages[adminLang][key] || adminMessages.en[key] || key;
    }

    function applyAdminLang() {
      document.documentElement.lang = adminLang === "zh" ? "zh-CN" : "en";
      document.querySelectorAll("[data-i18n]").forEach((node) => {
        const key = node.getAttribute("data-i18n");
        node.textContent = t(key);
      });
      localStorage.setItem("routerLang", adminLang);
    }

    usernameInput.value = localStorage.getItem("routerAdminUsername") || "";
    templateSelect.innerHTML = channelTemplates.map((template) => '<option value="' + escapeHtml(template.id) + '">' + escapeHtml(template.label) + '</option>').join("");

    function authHeaders(extra = {}) {
      return { ...extra };
    }

    function setStatus(message, type = "") {
      statusBox.textContent = message;
      statusBox.className = "status" + (type ? " " + type : "");
    }

    async function requestJson(path, options = {}) {
      const response = await fetch(path, { credentials: "same-origin", ...options });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Request failed with " + response.status);
      }

      return data;
    }

    async function login() {
      localStorage.setItem("routerAdminUsername", usernameInput.value.trim());
      await requestJson("/admin/login", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          username: usernameInput.value.trim(),
          password: passwordInput.value
        })
      });
      passwordInput.value = "";
      setStatus(t("loggedIn"), "ok");
      await loadAll();
    }

    async function logout() {
      await requestJson("/admin/logout", {
        method: "POST",
        headers: authHeaders()
      });
      setStatus(t("loggedOut"), "ok");
    }

    function renderChannels(channels) {
      channelCount.textContent = String(channels.length);
      enabledCount.textContent = String(channels.filter((item) => item.enabled !== false).length);

      if (!channels.length) {
        channelRows.innerHTML = '<tr><td colspan="5" class="subtle">' + escapeHtml(t("noChannels")) + '</td></tr>';
        return;
      }

      channelRows.innerHTML = channels.map((item) => {
        const models = Array.isArray(item.models) && item.models.length ? item.models.join(", ") : "all models";
        const status = item.enabled === false ? '<span class="badge off">' + escapeHtml(t("disabledBadge")) + '</span>' : '<span class="badge">' + escapeHtml(t("enabledBadge")) + '</span>';
        const check = checkResults[item.id];
        const checkHtml = check ? renderCheck(check) : '<span class="subtle">' + escapeHtml(t("notChecked")) + '</span>';
        return '<tr>' +
          '<td><code>' + escapeHtml(item.id || "") + '</code></td>' +
          '<td><code>' + escapeHtml(item.baseUrl || "") + '</code></td>' +
          '<td>' + escapeHtml(models) + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' + checkHtml + '</td>' +
        '</tr>';
      }).join("");
    }

    function renderCheck(result) {
      const label = result.ok ? t("ok") : t("failed");
      const klass = result.ok ? "ok" : "error";
      const detail = result.status ? "HTTP " + result.status + ", " + result.latencyMs + "ms" : result.latencyMs + "ms";
      const error = result.error ? " - " + result.error : "";
      return '<span class="badge ' + klass + '">' + label + '</span><div class="subtle">' + escapeHtml(detail + error) + '</div>';
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    async function loadAll() {
      const raw = await requestJson("/admin/channels/raw", {
        headers: authHeaders()
      });
      const cursors = await requestJson("/admin/cursors", {
        headers: authHeaders()
      });

      editor.value = JSON.stringify(raw.channels || [], null, 2);
      renderChannels(raw.channels || []);
      cursorsBox.textContent = JSON.stringify(cursors, null, 2);
      cursorCount.textContent = String(Object.keys(cursors).length);
      setStatus(t("loaded"), "ok");
    }

    async function saveChannels() {
      const channels = JSON.parse(editor.value);
      if (!Array.isArray(channels)) {
        throw new Error(t("invalidJson"));
      }

      const result = await requestJson("/admin/channels", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ channels })
      });
      renderChannels(result.channels || []);
      await loadAll();
      setStatus(t("saved"), "ok");
    }

    function appendTemplate() {
      const template = channelTemplates.find((item) => item.id === templateSelect.value) || channelTemplates[0];
      const channels = JSON.parse(editor.value);
      if (!Array.isArray(channels)) {
        throw new Error(t("invalidJson"));
      }

      const nextChannel = JSON.parse(JSON.stringify(template.channel));
      const existingIds = new Set(channels.map((item) => item && item.id).filter(Boolean));
      let nextId = nextChannel.id;
      let suffix = 2;
      while (existingIds.has(nextId)) {
        nextId = nextChannel.id + "-" + suffix;
        suffix += 1;
      }
      nextChannel.id = nextId;
      channels.push(nextChannel);
      editor.value = JSON.stringify(channels, null, 2);
      renderChannels(channels);
      setStatus(t("templateAdded"), "ok");
    }

    async function checkChannels() {
      setStatus(t("checking"), "");
      const data = await requestJson("/admin/channels/check", {
        method: "POST",
        headers: authHeaders()
      });
      checkResults = Object.fromEntries((data.results || []).map((result) => [result.id, result]));
      const channels = JSON.parse(editor.value);
      renderChannels(Array.isArray(channels) ? channels : []);
      setStatus(data.ok ? t("allAvailable") : t("someFailed"), data.ok ? "ok" : "error");
    }

    document.querySelector("#loadBtn").addEventListener("click", () => {
      loadAll().catch((error) => setStatus(error.message, "error"));
    });

    document.querySelector("#refreshBtn").addEventListener("click", () => {
      loadAll().catch((error) => setStatus(error.message, "error"));
    });

    document.querySelector("#saveBtn").addEventListener("click", () => {
      saveChannels().catch((error) => setStatus(error.message, "error"));
    });

    document.querySelector("#appendTemplateBtn").addEventListener("click", () => {
      try {
        appendTemplate();
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    document.querySelector("#checkChannelsBtn").addEventListener("click", () => {
      checkChannels().catch((error) => setStatus(error.message, "error"));
    });

    document.querySelector("#loginBtn").addEventListener("click", () => {
      login().catch((error) => setStatus(error.message, "error"));
    });

    document.querySelector("#logoutBtn").addEventListener("click", () => {
      logout().catch((error) => setStatus(error.message, "error"));
    });

    document.querySelector("#adminLangBtn").addEventListener("click", () => {
      adminLang = adminLang === "zh" ? "en" : "zh";
      applyAdminLang();
      try {
        const channels = JSON.parse(editor.value);
        renderChannels(Array.isArray(channels) ? channels : []);
      } catch {}
    });

    document.querySelector("#healthBtn").addEventListener("click", async () => {
      try {
        const response = await fetch("/health");
        const data = await response.json();
        setStatus(data.ok ? t("healthOk") : t("healthBad"), data.ok ? "ok" : "error");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
    applyAdminLang();
  </script>
</body>
</html>`;
}

function homePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenAI-compatible Router</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #667085;
      --line: #d9deea;
      --accent: #186ade;
      --accent-strong: #0f4fb3;
      --ok: #16845b;
      --shadow: 0 16px 40px rgba(31, 42, 68, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    header {
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 2;
    }

    .header-inner,
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding-left: 22px;
      padding-right: 22px;
    }

    .header-inner {
      min-height: 74px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .brand {
      display: grid;
      gap: 2px;
    }

    .brand strong {
      font-size: 18px;
      letter-spacing: 0;
    }

    .muted {
      color: var(--muted);
      font-size: 13px;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    button,
    a.button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--text);
      padding: 0 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      font: 650 13px/1 Inter, ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }

    a.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }

    a.primary:hover {
      background: var(--accent-strong);
    }

    main {
      padding-top: 52px;
      padding-bottom: 56px;
      display: grid;
      gap: 22px;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(320px, 0.95fr);
      gap: 22px;
      align-items: stretch;
    }

    .copy {
      padding: 18px 0;
      display: grid;
      align-content: center;
      gap: 18px;
    }

    h1 {
      margin: 0;
      max-width: 740px;
      font-size: clamp(34px, 5vw, 62px);
      line-height: 1.02;
      font-weight: 800;
      letter-spacing: 0;
    }

    .lead {
      max-width: 640px;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.65;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 18px;
    }

    .stack {
      display: grid;
      gap: 14px;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .endpoint {
      display: grid;
      gap: 8px;
    }

    code,
    pre {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      color: #344054;
    }

    .codebox {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border-radius: 7px;
      background: #f2f5fa;
      border: 1px solid var(--line);
      overflow-x: auto;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }

    .card {
      min-height: 132px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      display: grid;
      align-content: start;
      gap: 8px;
    }

    .card h2 {
      margin: 0;
      font-size: 15px;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--muted);
    }

    .status.ok .dot {
      background: var(--ok);
    }

    @media (max-width: 820px) {
      .header-inner,
      .hero {
        grid-template-columns: 1fr;
      }

      .header-inner {
        align-items: flex-start;
        flex-direction: column;
        padding-top: 16px;
        padding-bottom: 16px;
      }

      main {
        padding-top: 30px;
      }

      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="brand">
        <strong data-i18n="brand">API Router</strong>
        <span class="muted" data-i18n="brandSub">OpenAI-compatible multi-channel gateway</span>
      </div>
      <div class="actions">
        <button id="langBtn" type="button">中文 / EN</button>
        <a class="button" href="/health" data-i18n="healthLink">Health</a>
        <a class="button primary" href="/admin" data-i18n="adminLink">Admin</a>
      </div>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="copy">
        <h1 data-i18n="title">One OpenAI-compatible endpoint for multiple upstream channels.</h1>
        <div class="lead" data-i18n="lead">Route chat and model requests through your configured providers, rotate channels by model, and keep the management surface close to the Worker.</div>
        <div class="actions">
          <a class="button primary" href="/admin" data-i18n="openAdmin">Open admin</a>
          <button id="checkHealth" type="button" data-i18n="checkHealth">Check health</button>
        </div>
        <div id="healthStatus" class="status"><span class="dot"></span><span data-i18n="healthIdle">Health not checked yet</span></div>
      </div>

      <div class="panel stack">
        <div class="row">
          <strong data-i18n="endpointTitle">API base URL</strong>
          <span class="muted" data-i18n="endpointHint">Use this in compatible clients</span>
        </div>
        <div class="endpoint">
          <span class="muted" data-i18n="clientAuto">Client appends /v1 automatically</span>
          <div class="codebox"><code id="rootEndpoint"></code><button class="copyBtn" data-target="rootEndpoint" type="button" data-i18n="copy">Copy</button></div>
        </div>
        <div class="endpoint">
          <span class="muted" data-i18n="clientManual">Client needs the full /v1 base</span>
          <div class="codebox"><code id="v1Endpoint"></code><button class="copyBtn" data-target="v1Endpoint" type="button" data-i18n="copy">Copy</button></div>
        </div>
      </div>
    </section>

    <section class="grid">
      <div class="card">
        <h2 data-i18n="cardRoutingTitle">Model-aware routing</h2>
        <div class="muted" data-i18n="cardRoutingText">Match channels by requested model, then rotate through available upstreams.</div>
      </div>
      <div class="card">
        <h2 data-i18n="cardFailoverTitle">Automatic failover</h2>
        <div class="muted" data-i18n="cardFailoverText">Retry another channel on common auth, rate-limit, timeout, and server failures.</div>
      </div>
      <div class="card">
        <h2 data-i18n="cardAdminTitle">Built-in admin</h2>
        <div class="muted" data-i18n="cardAdminText">Manage channels, inspect cursors, and check upstream availability from /admin.</div>
      </div>
    </section>
  </main>

  <script>
    const messages = {
      en: {
        brand: "API Router",
        brandSub: "OpenAI-compatible multi-channel gateway",
        healthLink: "Health",
        adminLink: "Admin",
        title: "One OpenAI-compatible endpoint for multiple upstream channels.",
        lead: "Route chat and model requests through your configured providers, rotate channels by model, and keep the management surface close to the Worker.",
        openAdmin: "Open admin",
        checkHealth: "Check health",
        healthIdle: "Health not checked yet",
        healthOk: "Worker is healthy",
        healthBad: "Health check failed",
        endpointTitle: "API base URL",
        endpointHint: "Use this in compatible clients",
        clientAuto: "Client appends /v1 automatically",
        clientManual: "Client needs the full /v1 base",
        copy: "Copy",
        copied: "Copied",
        cardRoutingTitle: "Model-aware routing",
        cardRoutingText: "Match channels by requested model, then rotate through available upstreams.",
        cardFailoverTitle: "Automatic failover",
        cardFailoverText: "Retry another channel on common auth, rate-limit, timeout, and server failures.",
        cardAdminTitle: "Built-in admin",
        cardAdminText: "Manage channels, inspect cursors, and check upstream availability from /admin."
      },
      zh: {
        brand: "API 路由器",
        brandSub: "OpenAI 兼容的多渠道聚合网关",
        healthLink: "健康检查",
        adminLink: "后台",
        title: "一个端点，聚合多个 OpenAI-compatible 渠道。",
        lead: "按模型匹配渠道、轮询上游、失败自动切换，并把渠道管理和可用性检测直接放在 Worker 里。",
        openAdmin: "打开后台",
        checkHealth: "检查状态",
        healthIdle: "还没有检查健康状态",
        healthOk: "Worker 状态正常",
        healthBad: "健康检查失败",
        endpointTitle: "API Base URL",
        endpointHint: "填到兼容 OpenAI 的客户端里",
        clientAuto: "客户端会自动拼 /v1",
        clientManual: "客户端需要完整 /v1 地址",
        copy: "复制",
        copied: "已复制",
        cardRoutingTitle: "按模型路由",
        cardRoutingText: "根据请求里的 model 筛选渠道，再对可用上游做轮询。",
        cardFailoverTitle: "失败自动切换",
        cardFailoverText: "遇到鉴权、限流、超时和上游服务错误时，自动尝试下一个渠道。",
        cardAdminTitle: "内置后台",
        cardAdminText: "在 /admin 管理渠道、查看游标，并检测上游可用性。"
      }
    };

    let lang = localStorage.getItem("routerLang") || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
    const rootEndpoint = document.querySelector("#rootEndpoint");
    const v1Endpoint = document.querySelector("#v1Endpoint");
    rootEndpoint.textContent = location.origin;
    v1Endpoint.textContent = location.origin + "/v1";

    function applyLang() {
      const dict = messages[lang];
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      document.querySelectorAll("[data-i18n]").forEach((node) => {
        const key = node.getAttribute("data-i18n");
        if (dict[key]) node.textContent = dict[key];
      });
      localStorage.setItem("routerLang", lang);
    }

    document.querySelector("#langBtn").addEventListener("click", () => {
      lang = lang === "zh" ? "en" : "zh";
      applyLang();
    });

    document.querySelector("#checkHealth").addEventListener("click", async () => {
      const status = document.querySelector("#healthStatus");
      try {
        const response = await fetch("/health");
        const data = await response.json();
        status.className = data.ok ? "status ok" : "status";
        status.querySelector("span:last-child").textContent = data.ok ? messages[lang].healthOk : messages[lang].healthBad;
      } catch {
        status.className = "status";
        status.querySelector("span:last-child").textContent = messages[lang].healthBad;
      }
    });

    document.querySelectorAll(".copyBtn").forEach((button) => {
      button.addEventListener("click", async () => {
        const target = document.querySelector("#" + button.dataset.target);
        await navigator.clipboard.writeText(target.textContent);
        button.textContent = messages[lang].copied;
        setTimeout(() => button.textContent = messages[lang].copy, 1200);
      });
    });

    applyLang();
  </script>
</body>
</html>`;
}
