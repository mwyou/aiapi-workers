type Env = {
  CHANNEL_STORE: KVNamespace;
  MAX_ATTEMPTS?: string;
  ADMIN_TOKEN?: string;
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

const CHANNELS_KV = "router:channels";
const CURSOR_PREFIX = "router:cursor:";
const RETRY_STATUSES = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health") {
      return withCors(json({ ok: true, service: "multi-channel-openai-router" }));
    }

    if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
      return html(adminPage());
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
  if (!isAdminAuthorized(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (url.pathname === "/admin/channels/raw" && request.method === "GET") {
    const channels = await getChannels(env);
    return json({ count: channels.length, channels });
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

function isAdminAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) {
    return false;
  }

  return bearerToken(request) === env.ADMIN_TOKEN;
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
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
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--text);
      font: inherit;
      outline: none;
    }

    input {
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
        <h1>Multi-channel Router Admin</h1>
        <div class="subtle">Manage OpenAI-compatible channels stored in Workers KV.</div>
      </div>
      <button id="healthBtn" type="button">Check health</button>
    </div>
  </header>

  <main>
    <div class="stack">
      <section class="panel stack">
        <label>
          Admin token
          <input id="token" type="password" autocomplete="current-password" placeholder="Bearer token for ADMIN_TOKEN">
        </label>
        <div class="row">
          <button id="loadBtn" class="primary" type="button">Load config</button>
          <button id="clearBtn" type="button">Forget token</button>
        </div>
        <div id="status" class="status">Enter ADMIN_TOKEN, then load the current channel config.</div>
      </section>

      <section class="panel summary">
        <div class="metric">
          <span class="subtle">Channels</span>
          <b id="channelCount">0</b>
        </div>
        <div class="metric">
          <span class="subtle">Enabled</span>
          <b id="enabledCount">0</b>
        </div>
        <div class="metric">
          <span class="subtle">Cursor scopes</span>
          <b id="cursorCount">0</b>
        </div>
      </section>
    </div>

    <div class="stack">
      <section class="panel stack">
        <div class="row">
          <div>
            <h2 style="margin:0;font-size:16px;">Channel JSON</h2>
            <div class="subtle">Edit the full channel array. Saving resets the default cursor.</div>
          </div>
          <button id="saveBtn" class="primary" type="button">Save channels</button>
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
      </section>

      <section class="panel stack">
        <div class="row">
          <h2 style="margin:0;font-size:16px;">Channels</h2>
          <button id="refreshBtn" type="button">Refresh</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Base URL</th>
                <th>Models</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="channelRows">
              <tr><td colspan="4" class="subtle">No data loaded.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel stack">
        <div class="row">
          <h2 style="margin:0;font-size:16px;">Cursors</h2>
          <span class="subtle">Per model round-robin position</span>
        </div>
        <pre id="cursors" class="status" style="white-space:pre-wrap;margin:0;">{}</pre>
      </section>
    </div>
  </main>

  <script>
    const tokenInput = document.querySelector("#token");
    const editor = document.querySelector("#editor");
    const statusBox = document.querySelector("#status");
    const channelRows = document.querySelector("#channelRows");
    const cursorsBox = document.querySelector("#cursors");
    const channelCount = document.querySelector("#channelCount");
    const enabledCount = document.querySelector("#enabledCount");
    const cursorCount = document.querySelector("#cursorCount");

    tokenInput.value = localStorage.getItem("routerAdminToken") || "";

    function authHeaders(extra = {}) {
      return {
        ...extra,
        Authorization: "Bearer " + tokenInput.value.trim()
      };
    }

    function setStatus(message, type = "") {
      statusBox.textContent = message;
      statusBox.className = "status" + (type ? " " + type : "");
    }

    async function requestJson(path, options = {}) {
      if (!tokenInput.value.trim() && path.startsWith("/admin/")) {
        throw new Error("ADMIN_TOKEN is required");
      }

      const response = await fetch(path, options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Request failed with " + response.status);
      }

      return data;
    }

    function renderChannels(channels) {
      channelCount.textContent = String(channels.length);
      enabledCount.textContent = String(channels.filter((item) => item.enabled !== false).length);

      if (!channels.length) {
        channelRows.innerHTML = '<tr><td colspan="4" class="subtle">No channels configured.</td></tr>';
        return;
      }

      channelRows.innerHTML = channels.map((item) => {
        const models = Array.isArray(item.models) && item.models.length ? item.models.join(", ") : "all models";
        const status = item.enabled === false ? '<span class="badge off">disabled</span>' : '<span class="badge">enabled</span>';
        return '<tr>' +
          '<td><code>' + escapeHtml(item.id || "") + '</code></td>' +
          '<td><code>' + escapeHtml(item.baseUrl || "") + '</code></td>' +
          '<td>' + escapeHtml(models) + '</td>' +
          '<td>' + status + '</td>' +
        '</tr>';
      }).join("");
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
      localStorage.setItem("routerAdminToken", tokenInput.value.trim());
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
      setStatus("Configuration loaded.", "ok");
    }

    async function saveChannels() {
      const channels = JSON.parse(editor.value);
      if (!Array.isArray(channels)) {
        throw new Error("Editor must contain a JSON array");
      }

      const result = await requestJson("/admin/channels", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ channels })
      });
      renderChannels(result.channels || []);
      await loadAll();
      setStatus("Channels saved.", "ok");
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

    document.querySelector("#clearBtn").addEventListener("click", () => {
      localStorage.removeItem("routerAdminToken");
      tokenInput.value = "";
      setStatus("Token removed from this browser.", "ok");
    });

    document.querySelector("#healthBtn").addEventListener("click", async () => {
      try {
        const response = await fetch("/health");
        const data = await response.json();
        setStatus(data.ok ? "Worker health check passed." : "Health check returned unexpected data.", data.ok ? "ok" : "error");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
  </script>
</body>
</html>`;
}
