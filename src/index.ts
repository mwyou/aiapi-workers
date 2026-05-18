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

type StoredAdmin = {
  username: string;
  passwordHash: string;
  salt: string;
  sessionSecret: string;
};

type RouterSettings = {
  proxyApiKey?: string;
};

const CHANNELS_KV = "router:channels";
const CURSOR_PREFIX = "router:cursor:";
const ADMIN_KV = "router:admin";
const SETTINGS_KV = "router:settings";
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

    if (!(await isProxyAuthorized(request, env))) {
        return withCors(json({ error: "Unauthorized. Configure a Gateway API key in /admin first." }, 401));
    }

    return withCors(await proxyToChannel(request, env, url));
  }
};

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/admin/setup" && request.method === "POST") {
    return setupAdmin(request, env, url);
  }

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

  if (url.pathname === "/admin/models" && request.method === "POST") {
    return fetchChannelModels(request);
  }

  if (url.pathname === "/admin/settings" && request.method === "GET") {
    const settings = await getSettings(env);
    return json({
      hasProxyApiKey: Boolean(settings.proxyApiKey || env.PROXY_API_KEY),
      source: settings.proxyApiKey ? "admin" : env.PROXY_API_KEY ? "env" : "none",
      proxyApiKeyPreview: maskSecret(settings.proxyApiKey || env.PROXY_API_KEY || "")
    });
  }

  if (url.pathname === "/admin/settings" && request.method === "PUT") {
    const body = await request.json<{ proxyApiKey?: unknown }>().catch(() => null);
    if (!body || typeof body.proxyApiKey !== "string") {
      return json({ error: "Expected JSON body: { \"proxyApiKey\": \"...\" }" }, 400);
    }

    const proxyApiKey = body.proxyApiKey.trim();
    if (proxyApiKey.length < 12) {
      return json({ error: "Proxy API key must be at least 12 characters" }, 400);
    }

    await putSettings(env, { proxyApiKey });
    return json({ ok: true, hasProxyApiKey: true, source: "admin", proxyApiKeyPreview: maskSecret(proxyApiKey) });
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

    const channels = dedupeChannels(normalizeChannels(rawChannels));

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

async function setupAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (await isAdminConfigured(env)) {
    return json({ error: "Admin account is already configured" }, 409);
  }

  const body = await request.json<{ username?: unknown; password?: unknown }>().catch(() => null);
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return json({ error: "Expected JSON body: { \"username\": \"...\", \"password\": \"...\" }" }, 400);
  }

  const username = body.username.trim();
  if (username.length < 3 || body.password.length < 8) {
    return json({ error: "Username must be at least 3 chars and password at least 8 chars" }, 400);
  }

  const salt = randomToken(18);
  const admin: StoredAdmin = {
    username,
    salt,
    passwordHash: await hashPassword(body.password, salt),
    sessionSecret: randomToken(32)
  };

  await env.CHANNEL_STORE.put(ADMIN_KV, JSON.stringify(admin));
  const token = await createAdminSession(env, admin);
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", sessionCookie(token, url, 86400));
  return new Response(JSON.stringify({ ok: true }, null, 2), { headers });
}

async function loginAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await request.json<{ username?: unknown; password?: unknown }>().catch(() => null);
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return json({ error: "Expected JSON body: { \"username\": \"...\", \"password\": \"...\" }" }, 400);
  }

  const storedAdmin = await getStoredAdmin(env);
  const envMatches = env.ADMIN_USERNAME && env.ADMIN_PASSWORD && body.username === env.ADMIN_USERNAME && body.password === env.ADMIN_PASSWORD;
  const kvMatches = storedAdmin && body.username === storedAdmin.username && (await hashPassword(body.password, storedAdmin.salt)) === storedAdmin.passwordHash;

  if (!envMatches && !kvMatches) {
    return json({ error: "Invalid username or password" }, 401);
  }

  const token = await createAdminSession(env, storedAdmin || undefined);
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

async function fetchChannelModels(request: Request): Promise<Response> {
  const body = await request.json<{ baseUrl?: unknown; apiKey?: unknown }>().catch(() => null);
  if (!body || typeof body.baseUrl !== "string" || typeof body.apiKey !== "string") {
    return json({ error: "Expected JSON body: { \"baseUrl\": \"...\", \"apiKey\": \"...\" }" }, 400);
  }

  const baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = body.apiKey.trim();
  if (!baseUrl || !apiKey) {
    return json({ error: "baseUrl and apiKey are required" }, 400);
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
    const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
    if (!response.ok) {
      return json({ error: `HTTP ${response.status}`, status: response.status }, response.status);
    }

    const data = Array.isArray(payload?.data) ? payload.data : [];
    const models = data
      .map((item) => (item && typeof item === "object" && "id" in item ? (item as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));

    return json({ ok: true, count: models.length, models });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Failed to fetch models" }, 502);
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

function dedupeChannels(channels: Channel[]): Channel[] {
  const seen = new Set<string>();
  return channels.filter((channel) => {
    const key = `${channel.baseUrl.replace(/\/+$/, "").toLowerCase()}::${channel.apiKey}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
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

async function isProxyAuthorized(request: Request, env: Env): Promise<boolean> {
  const proxyApiKey = await getProxyApiKey(env);
  if (!proxyApiKey) {
    return false;
  }

  return timingSafeEqual(bearerToken(request) || "", proxyApiKey);
}

async function isAdminAuthorized(request: Request, env: Env): Promise<boolean> {
  if (env.ADMIN_TOKEN && bearerToken(request) === env.ADMIN_TOKEN) {
    return true;
  }

  return verifyAdminSession(cookieValue(request, "admin_session"), env, await getStoredAdmin(env));
}

async function isAdminConfigured(env: Env): Promise<boolean> {
  return Boolean((env.ADMIN_USERNAME && env.ADMIN_PASSWORD) || (await getStoredAdmin(env)));
}

async function getStoredAdmin(env: Env): Promise<StoredAdmin | null> {
  const raw = await env.CHANNEL_STORE.get(ADMIN_KV);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredAdmin>;
    if (parsed.username && parsed.passwordHash && parsed.salt && parsed.sessionSecret) {
      return parsed as StoredAdmin;
    }
  } catch {}

  return null;
}

async function getSettings(env: Env): Promise<RouterSettings> {
  const raw = await env.CHANNEL_STORE.get(SETTINGS_KV);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RouterSettings>;
    return {
      proxyApiKey: typeof parsed.proxyApiKey === "string" && parsed.proxyApiKey.trim() ? parsed.proxyApiKey.trim() : undefined
    };
  } catch {
    return {};
  }
}

async function putSettings(env: Env, settings: RouterSettings): Promise<void> {
  await env.CHANNEL_STORE.put(SETTINGS_KV, JSON.stringify(settings));
}

async function getProxyApiKey(env: Env): Promise<string | undefined> {
  const settings = await getSettings(env);
  return settings.proxyApiKey || env.PROXY_API_KEY;
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

async function createAdminSession(env: Env, admin?: StoredAdmin): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + 86400;
  const payload = base64UrlEncode(JSON.stringify({ exp: expiresAt }));
  const signature = await hmac(payload, sessionSecret(env, admin));
  return `${payload}.${signature}`;
}

async function verifyAdminSession(token: string | null, env: Env, admin: StoredAdmin | null): Promise<boolean> {
  if (!token) {
    return false;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return false;
  }

  const expected = await hmac(payload, sessionSecret(env, admin || undefined));
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

function sessionSecret(env: Env, admin?: StoredAdmin): string {
  return admin?.sessionSecret || env.ADMIN_SESSION_SECRET || env.ADMIN_TOKEN || env.ADMIN_PASSWORD || "change-me";
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: 100000
    },
    key,
    256
  );
  return base64UrlEncodeBytes(new Uint8Array(bits));
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64UrlEncodeBytes(data);
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

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }

  return diff === 0;
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
      max-width: 1680px;
      margin: 0 auto;
      padding: 12px 18px;
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
      max-width: 1680px;
      margin: 0 auto;
      padding: 16px 18px 28px;
      display: grid;
      grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
      gap: 14px;
    }

    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .panel {
      padding: 14px;
    }

    .stack {
      display: grid;
      gap: 12px;
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
      height: 36px;
      padding: 0 10px;
    }

    textarea {
      min-height: 220px;
      padding: 12px;
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
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--text);
      padding: 0 13px;
      font: 650 13px/1 Inter, ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }

    a.button {
      height: 36px;
      border: 1px solid var(--accent);
      border-radius: 7px;
      background: var(--accent);
      color: #fff;
      padding: 0 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      font: 650 13px/1 Inter, ui-sans-serif, system-ui, sans-serif;
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

    .form-grid {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(180px, 0.7fr) minmax(240px, 1fr);
      gap: 10px;
    }

    .form-grid .wide {
      grid-column: 1 / -1;
    }

    .form-grid .span-2 {
      grid-column: span 2;
    }

    .mini-textarea {
      min-height: 76px;
    }

    #editor {
      min-height: 240px;
      max-height: 420px;
    }

    .checkline {
      display: flex;
      align-items: center;
      gap: 9px;
      font-weight: 650;
    }

    .checkline input {
      width: 16px;
      height: 16px;
      padding: 0;
    }

    .model-picker {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .model-chip {
      min-height: 30px;
      height: auto;
      max-width: 100%;
      justify-content: flex-start;
      overflow-wrap: anywhere;
      border-color: #c9d5ea;
      background: #f8fbff;
      color: #344054;
      font-weight: 650;
    }

    .metric {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
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

    .group-row td {
      background: #f7f9fd;
      color: var(--text);
      font-weight: 750;
      border-top: 1px solid var(--line);
      border-bottom-color: #d8e0ee;
    }

    .group-meta {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-left: 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      text-transform: none;
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

      .form-grid {
        grid-template-columns: 1fr;
      }

      .form-grid .span-2 {
        grid-column: 1 / -1;
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
  <script>
    (function () {
      const fallbackMessages = {
        en: {
          adminTitle: "Multi-channel Router Admin",
          adminSub: "Manage OpenAI-compatible channels stored in Workers KV.",
          checkHealth: "Check health",
          home: "Home",
          logout: "Logout",
          loadConfig: "Load config",
          adminReady: "You are signed in. Load the current channel config to start.",
          channels: "Channels",
          enabled: "Enabled",
          cursorScopes: "Cursor scopes",
          proxyKeyTitle: "Gateway API key",
          proxyKeyHint: "External clients use this key to call /v1.",
          proxyKeyInput: "New API key",
          generateProxyKey: "Generate",
          saveProxyKey: "Save key",
          proxyKeyGenerated: "Generated locally. Save it before use.",
          proxyKeySaved: "Gateway API key saved. Copy it into your external client.",
          quickAdd: "Quick add channels",
          quickAddHint: "Choose a template, paste one or more API keys, then generate channels.",
          generateChannels: "Generate channels",
          templateLabel: "Channel template",
          channelIdPrefix: "ID prefix",
          channelName: "Channel name",
          baseUrl: "Base URL",
          modelsInput: "Models",
          modelSearch: "Search fetched models",
          apiKeysInput: "API keys",
          channelJson: "Channel JSON",
          channelJsonHint: "Edit the full channel array. Saving resets the default cursor.",
          saveChannels: "Save channels",
          checkChannels: "Check channels",
          refresh: "Refresh",
          cursors: "Cursors",
          cursorsHint: "Per model round-robin position"
        },
        zh: {
          adminTitle: "多渠道路由后台",
          adminSub: "管理保存在 Workers KV 中的 OpenAI-compatible 渠道。",
          checkHealth: "健康检查",
          home: "首页",
          logout: "退出",
          loadConfig: "加载配置",
          adminReady: "你已登录。加载当前渠道配置后即可开始管理。",
          channels: "渠道",
          enabled: "启用",
          cursorScopes: "游标范围",
          proxyKeyTitle: "网关调用 Key",
          proxyKeyHint: "外部客户端用这个 Key 调用 /v1。",
          proxyKeyInput: "新的 API Key",
          generateProxyKey: "生成",
          saveProxyKey: "保存 Key",
          proxyKeyGenerated: "已在本地生成，使用前请先保存。",
          proxyKeySaved: "网关调用 Key 已保存。把它填到外部客户端里使用。",
          quickAdd: "快速添加渠道",
          quickAddHint: "选择模板，粘贴一个或多个 API Key，然后生成渠道。",
          generateChannels: "生成渠道",
          templateLabel: "渠道模板",
          channelIdPrefix: "ID 前缀",
          channelName: "渠道名称",
          baseUrl: "Base URL",
          modelsInput: "模型",
          modelSearch: "搜索已获取模型",
          apiKeysInput: "API Key",
          channelJson: "渠道 JSON",
          channelJsonHint: "编辑完整渠道数组。保存后会重置默认游标。",
          saveChannels: "保存渠道",
          checkChannels: "检测渠道",
          refresh: "刷新",
          cursors: "游标",
          cursorsHint: "每个模型的轮询位置"
        }
      };

      function currentLang() {
        try {
          const stored = window.localStorage && window.localStorage.getItem("routerLang");
          if (stored === "zh" || stored === "en") return stored;
        } catch {}
        return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
      }

      function setLang(value) {
        try {
          if (window.localStorage) window.localStorage.setItem("routerLang", value);
        } catch {}
      }

      function setBox(selector, message, type) {
        const box = document.querySelector(selector);
        if (!box) return;
        box.textContent = message;
        box.className = "status" + (type ? " " + type : "");
      }

      function translate(lang) {
        const pack = fallbackMessages[lang] || fallbackMessages.en;
        document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
        document.querySelectorAll("[data-i18n]").forEach((node) => {
          const key = node.getAttribute("data-i18n");
          if (key && pack[key]) node.textContent = pack[key];
        });
        const button = document.querySelector("#adminLangBtn");
        if (button) button.textContent = lang === "zh" ? "EN" : "中文";
      }

      window.toggleAdminLang = function () {
        const next = currentLang() === "zh" ? "en" : "zh";
        setLang(next);
        translate(next);
      };

      window.generateGatewayKey = function () {
        const input = document.querySelector("#proxyApiKey");
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (input) {
          input.value = "sk-router-" + key;
          input.select();
        }
        setBox("#proxyKeyStatus", fallbackMessages[currentLang()].proxyKeyGenerated, "ok");
      };

      window.saveGatewayKey = async function () {
        const input = document.querySelector("#proxyApiKey");
        const proxyApiKey = input && input.value ? input.value.trim() : "";
        if (!proxyApiKey) {
          setBox("#proxyKeyStatus", currentLang() === "zh" ? "请先生成或输入 API Key。" : "Generate or enter an API key first.", "error");
          return;
        }
        try {
          const response = await fetch("/admin/settings", {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proxyApiKey })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Request failed with " + response.status);
          setBox("#proxyKeyStatus", fallbackMessages[currentLang()].proxyKeySaved, "ok");
        } catch (error) {
          setBox("#proxyKeyStatus", error && error.message ? error.message : "Request failed", "error");
        }
      };

      document.addEventListener("DOMContentLoaded", () => translate(currentLang()));
    })();
  </script>
</head>
<body>
  <header>
    <div class="header-inner">
      <div>
        <h1 data-i18n="adminTitle">Multi-channel Router Admin</h1>
        <div class="subtle" data-i18n="adminSub">Manage OpenAI-compatible channels stored in Workers KV.</div>
      </div>
      <div class="row">
        <button id="adminLangBtn" type="button" onclick="window.toggleAdminLang && window.toggleAdminLang()">中文</button>
        <button id="healthBtn" type="button" data-i18n="checkHealth">Check health</button>
      </div>
    </div>
  </header>

  <main>
    <div class="stack">
      <section class="panel stack">
        <div class="row">
          <a class="button primary" href="/" data-i18n="home">Home</a>
          <button id="logoutBtn" type="button" data-i18n="logout">Logout</button>
        </div>
        <button id="loadBtn" type="button" data-i18n="loadConfig">Load config</button>
        <div id="status" class="status" data-i18n="adminReady">You are signed in. Load the current channel config to start.</div>
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

      <section class="panel stack">
        <div>
          <h2 style="margin:0;font-size:16px;" data-i18n="proxyKeyTitle">Gateway API key</h2>
          <div class="subtle" data-i18n="proxyKeyHint">External clients use this key to call /v1.</div>
        </div>
        <label>
          <span data-i18n="proxyKeyInput">New API key</span>
          <input id="proxyApiKey" type="text" autocomplete="off" placeholder="sk-router-...">
        </label>
        <div class="row">
          <button id="generateProxyKeyBtn" type="button" data-i18n="generateProxyKey" onclick="window.generateGatewayKey && window.generateGatewayKey()">Generate</button>
          <button id="saveProxyKeyBtn" class="primary" type="button" data-i18n="saveProxyKey" onclick="window.saveGatewayKey && window.saveGatewayKey()">Save key</button>
        </div>
        <div id="proxyKeyStatus" class="status" data-i18n="proxyKeyUnknown">Not loaded.</div>
      </section>
    </div>

    <div class="stack">
      <section class="panel stack">
        <div class="row">
          <div>
            <h2 style="margin:0;font-size:16px;" data-i18n="quickAdd">Quick add channels</h2>
            <div class="subtle" data-i18n="quickAddHint">Choose a template, paste one or more API keys, then generate channels.</div>
          </div>
          <button id="generateChannelsBtn" class="primary" type="button" data-i18n="generateChannels">Generate channels</button>
        </div>
        <div class="form-grid">
          <label>
            <span data-i18n="templateLabel">Channel template</span>
            <select id="templateSelect">
              <option value="openai">OpenAI</option>
              <option value="nvidia">NVIDIA NIM</option>
              <option value="openrouter">OpenRouter</option>
              <option value="deepseek">DeepSeek</option>
              <option value="groq">Groq</option>
              <option value="together">Together AI</option>
              <option value="siliconflow">SiliconFlow</option>
              <option value="moonshot">Moonshot</option>
              <option value="dashscope">Alibaba DashScope</option>
              <option value="custom">Custom OpenAI-compatible</option>
            </select>
          </label>
          <label>
            <span data-i18n="channelIdPrefix">ID prefix</span>
            <input id="channelIdPrefix" type="text" placeholder="deepseek">
          </label>
          <label>
            <span data-i18n="channelName">Channel name</span>
            <input id="channelName" type="text" placeholder="DeepSeek">
          </label>
          <label class="span-2">
            <span data-i18n="baseUrl">Base URL</span>
            <input id="channelBaseUrl" type="url" placeholder="https://api.example.com/v1">
          </label>
          <label class="span-2">
            <span data-i18n="modelsInput">Models</span>
            <input id="channelModels" type="text" placeholder="model-a, model-b">
          </label>
          <div class="row">
            <button id="fetchModelsBtn" type="button" data-i18n="fetchModels">Fetch models</button>
          </div>
          <label class="span-2">
            <span data-i18n="modelSearch">Search fetched models</span>
            <input id="modelSearch" type="search" placeholder="qwen, gpt, llama">
          </label>
          <div id="modelPicker" class="model-picker wide"></div>
          <label class="wide">
            <span data-i18n="apiKeysInput">API keys</span>
            <textarea id="channelApiKeys" class="mini-textarea" spellcheck="false" placeholder="One API key per line"></textarea>
          </label>
          <label class="checkline">
            <input id="channelEnabled" type="checkbox" checked>
            <span data-i18n="enabled">Enabled</span>
          </label>
        </div>
      </section>

      <section class="panel stack">
        <div class="row">
          <div>
            <h2 style="margin:0;font-size:16px;" data-i18n="channelJson">Channel JSON</h2>
            <div class="subtle" data-i18n="channelJsonHint">Edit the full channel array. Saving resets the default cursor.</div>
          </div>
          <button id="saveBtn" class="primary" type="button" data-i18n="saveChannels">Save channels</button>
        </div>
        <textarea id="editor" spellcheck="false">[]</textarea>
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
    const editor = document.querySelector("#editor");
    const statusBox = document.querySelector("#status");
    const channelRows = document.querySelector("#channelRows");
    const cursorsBox = document.querySelector("#cursors");
    const channelCount = document.querySelector("#channelCount");
    const enabledCount = document.querySelector("#enabledCount");
    const cursorCount = document.querySelector("#cursorCount");
    const templateSelect = document.querySelector("#templateSelect");
    const channelIdPrefixInput = document.querySelector("#channelIdPrefix");
    const channelNameInput = document.querySelector("#channelName");
    const channelBaseUrlInput = document.querySelector("#channelBaseUrl");
    const channelModelsInput = document.querySelector("#channelModels");
    const modelSearchInput = document.querySelector("#modelSearch");
    const channelApiKeysInput = document.querySelector("#channelApiKeys");
    const channelEnabledInput = document.querySelector("#channelEnabled");
    const modelPicker = document.querySelector("#modelPicker");
    const proxyApiKeyInput = document.querySelector("#proxyApiKey");
    const proxyKeyStatus = document.querySelector("#proxyKeyStatus");
    let checkResults = {};
    let lastAppliedTemplateId = "";
    let fetchedModels = [];
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
        home: "Home",
        username: "Username",
        password: "Password",
        login: "Login",
        logout: "Logout",
        loadConfig: "Load config",
        loginHint: "Login with ADMIN_USERNAME and ADMIN_PASSWORD, then load the current channel config.",
        adminReady: "You are signed in. Load the current channel config to start.",
        channels: "Channels",
        enabled: "Enabled",
        cursorScopes: "Cursor scopes",
        proxyKeyTitle: "Gateway API key",
        proxyKeyHint: "External clients use this key to call /v1.",
        proxyKeyInput: "New API key",
        generateProxyKey: "Generate",
        saveProxyKey: "Save key",
        proxyKeyUnknown: "Not loaded.",
        proxyKeySaved: "Gateway API key saved. Copy it into your external client.",
        proxyKeyGenerated: "Generated locally. Save it before use.",
        proxyKeyStatusAdmin: "Configured in admin: {preview}",
        proxyKeyStatusEnv: "Using PROXY_API_KEY environment secret: {preview}",
        proxyKeyStatusNone: "No gateway API key configured. Public /v1 calls are open.",
        proxyKeyRequired: "Generate or enter an API key first.",
        quickAdd: "Quick add channels",
        quickAddHint: "Choose a template, paste one or more API keys, then generate channels.",
        generateChannels: "Generate channels",
        channelIdPrefix: "ID prefix",
        channelName: "Channel name",
        modelsInput: "Models",
        modelSearch: "Search fetched models",
        apiKeysInput: "API keys",
        fetchModels: "Fetch models",
        fetchModelsHint: "Uses Base URL and the first API key.",
        channelJson: "Channel JSON",
        channelJsonHint: "Edit the full channel array. Saving resets the default cursor.",
        templateLabel: "Channel template",
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
        accounts: "accounts",
        allModels: "all models",
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
        templateApplied: "{name} template applied.",
        templateAdded: "Added {added} channel(s), skipped {skipped} duplicate key(s). Review them, then save.",
        noNewKeys: "No new channels added. These keys already exist for this Base URL.",
        apiKeysRequired: "Paste at least one API key.",
        modelsLoaded: "Models loaded. Click a model to add it.",
        noModelsFound: "No models were returned by this channel.",
        modelSearchEmpty: "No fetched models match this search.",
        invalidJson: "Editor must contain a JSON array."
      },
      zh: {
        adminTitle: "多渠道路由后台",
        adminSub: "管理保存在 Workers KV 中的 OpenAI-compatible 渠道。",
        checkHealth: "健康检查",
        home: "首页",
        username: "账号",
        password: "密码",
        login: "登录",
        logout: "退出",
        loadConfig: "加载配置",
        loginHint: "使用 ADMIN_USERNAME 和 ADMIN_PASSWORD 登录，然后加载渠道配置。",
        adminReady: "你已登录。加载当前渠道配置后即可开始管理。",
        channels: "渠道",
        enabled: "启用",
        cursorScopes: "游标范围",
        proxyKeyTitle: "网关调用 Key",
        proxyKeyHint: "外部客户端用这个 Key 调用 /v1。",
        proxyKeyInput: "新的 API Key",
        generateProxyKey: "生成",
        saveProxyKey: "保存 Key",
        proxyKeyUnknown: "尚未加载。",
        proxyKeySaved: "网关调用 Key 已保存。把它填到外部客户端里使用。",
        proxyKeyGenerated: "已在本地生成，使用前请先保存。",
        proxyKeyStatusAdmin: "后台已配置：{preview}",
        proxyKeyStatusEnv: "正在使用 PROXY_API_KEY 环境密钥：{preview}",
        proxyKeyStatusNone: "还没有配置网关调用 Key，公网 /v1 调用将不鉴权。",
        proxyKeyRequired: "请先生成或输入 API Key。",
        quickAdd: "快速添加渠道",
        quickAddHint: "选择模板，粘贴一个或多个 API Key，然后生成渠道。",
        generateChannels: "生成渠道",
        channelIdPrefix: "ID 前缀",
        channelName: "渠道名称",
        modelsInput: "模型",
        modelSearch: "搜索已获取模型",
        apiKeysInput: "API Key",
        fetchModels: "获取模型",
        fetchModelsHint: "使用 Base URL 和第一条 API Key。",
        channelJson: "渠道 JSON",
        channelJsonHint: "编辑完整渠道数组。保存后会重置默认游标。",
        templateLabel: "渠道模板",
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
        accounts: "账号",
        allModels: "全部模型",
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
        templateApplied: "已应用 {name} 模板。",
        templateAdded: "已添加 {added} 个渠道，跳过 {skipped} 个重复 Key。请检查后保存。",
        noNewKeys: "没有新增渠道。这些 Key 在当前 Base URL 下已经存在。",
        apiKeysRequired: "请至少粘贴一个 API Key。",
        modelsLoaded: "模型已加载。点击模型即可添加。",
        noModelsFound: "该渠道没有返回模型列表。",
        modelSearchEmpty: "没有匹配的已获取模型。",
        invalidJson: "编辑器内容必须是 JSON 数组。"
      }
    };
    function storageGet(key) {
      try {
        return window.localStorage ? window.localStorage.getItem(key) : null;
      } catch {
        return null;
      }
    }

    function storageSet(key, value) {
      try {
        if (window.localStorage) window.localStorage.setItem(key, value);
      } catch {}
    }

    function normalizeLang(value) {
      return value === "zh" || value === "en" ? value : ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
    }

    let adminLang = normalizeLang(storageGet("routerLang"));

    function t(key) {
      const pack = adminMessages[adminLang] || adminMessages.en;
      return pack[key] || adminMessages.en[key] || key;
    }

    function applyAdminLang() {
      document.documentElement.lang = adminLang === "zh" ? "zh-CN" : "en";
      document.querySelectorAll("[data-i18n]").forEach((node) => {
        const key = node.getAttribute("data-i18n");
        node.textContent = t(key);
      });
      const langButton = document.querySelector("#adminLangBtn");
      if (langButton) {
        langButton.textContent = adminLang === "zh" ? "EN" : "中文";
      }
      storageSet("routerLang", adminLang);
    }

    function toggleAdminLang() {
      adminLang = adminLang === "zh" ? "en" : "zh";
      applyAdminLang();
      try {
        const channels = JSON.parse(editor.value);
        renderChannels(Array.isArray(channels) ? channels : []);
      } catch {}
    }

    window.toggleAdminLang = toggleAdminLang;

    window.addEventListener("error", (event) => {
      setStatus(event.message || "Page script error", "error");
    });

    window.addEventListener("unhandledrejection", (event) => {
      setStatus(event.reason && event.reason.message ? event.reason.message : "Async request failed", "error");
    });

    function authHeaders(extra = {}) {
      return { ...extra };
    }

    function selectedTemplate() {
      return channelTemplates.find((item) => item.id === templateSelect.value) || channelTemplates[0];
    }

    function applyTemplateFields() {
      const template = selectedTemplate();
      const channel = template.channel;
      lastAppliedTemplateId = template.id;
      templateSelect.value = template.id;
      channelIdPrefixInput.value = channel.id;
      channelNameInput.value = channel.name || template.label;
      channelBaseUrlInput.value = channel.baseUrl;
      channelModelsInput.value = (channel.models || []).join(", ");
      channelEnabledInput.checked = channel.enabled !== false;
      modelSearchInput.value = "";
      fetchedModels = [];
      modelPicker.innerHTML = "";
      setStatus(t("templateApplied").replace("{name}", template.label), "ok");
    }

    function setStatus(message, type = "") {
      statusBox.textContent = message;
      statusBox.className = "status" + (type ? " " + type : "");
    }

    function setProxyKeyStatus(message, type = "") {
      proxyKeyStatus.textContent = message;
      proxyKeyStatus.className = "status" + (type ? " " + type : "");
    }

    async function requestJson(path, options = {}) {
      const response = await fetch(path, { credentials: "same-origin", ...options });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Request failed with " + response.status);
      }

      return data;
    }

    function currentApiKeys() {
      return channelApiKeysInput.value.split(/\\r?\\n/).map((key) => key.trim()).filter(Boolean);
    }

    function selectedModels() {
      return channelModelsInput.value.split(",").map((model) => model.trim()).filter(Boolean);
    }

    function normalizeBaseUrl(value) {
      let normalized = String(value || "").trim();
      while (normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }
      return normalized.toLowerCase();
    }

    function channelFingerprint(channel) {
      return normalizeBaseUrl(channel && channel.baseUrl) + "::" + String(channel && channel.apiKey || "").trim();
    }

    function setSelectedModels(models) {
      channelModelsInput.value = [...new Set(models)].join(", ");
    }

    function addModel(model) {
      setSelectedModels([...selectedModels(), model]);
    }

    function renderModelPicker(models) {
      const query = modelSearchInput.value.trim().toLowerCase();
      const visibleModels = query ? models.filter((model) => model.toLowerCase().includes(query)) : models;
      if (models.length && visibleModels.length === 0) {
        modelPicker.innerHTML = '<div class="subtle">' + escapeHtml(t("modelSearchEmpty")) + '</div>';
        return;
      }

      modelPicker.innerHTML = visibleModels.map((model) => '<button class="model-chip" type="button" data-model="' + escapeHtml(model) + '">' + escapeHtml(model) + '</button>').join("");
      modelPicker.querySelectorAll("[data-model]").forEach((button) => {
        button.addEventListener("click", () => addModel(button.dataset.model));
      });
    }

    async function fetchModels() {
      const apiKey = currentApiKeys()[0];
      if (!apiKey) {
        throw new Error(t("apiKeysRequired"));
      }

      setStatus(t("checking"), "");
      const data = await requestJson("/admin/models", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          baseUrl: channelBaseUrlInput.value.trim(),
          apiKey
        })
      });
      fetchedModels = data.models || [];
      modelSearchInput.value = "";
      renderModelPicker(fetchedModels);
      setStatus(fetchedModels.length ? t("modelsLoaded") : t("noModelsFound"), fetchedModels.length ? "ok" : "");
    }

    async function loadSettings() {
      const settings = await requestJson("/admin/settings", {
        headers: authHeaders()
      });

      proxyApiKeyInput.value = "";
      const preview = settings.proxyApiKeyPreview || "";
      if (settings.source === "admin") {
        setProxyKeyStatus(t("proxyKeyStatusAdmin").replace("{preview}", preview), "ok");
      } else if (settings.source === "env") {
        setProxyKeyStatus(t("proxyKeyStatusEnv").replace("{preview}", preview), "ok");
      } else {
        setProxyKeyStatus(t("proxyKeyStatusNone"), "error");
      }
    }

    function generateProxyApiKey() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      proxyApiKeyInput.value = "sk-router-" + value;
      proxyApiKeyInput.select();
      setProxyKeyStatus(t("proxyKeyGenerated"), "ok");
    }

    async function saveProxyApiKey() {
      const proxyApiKey = proxyApiKeyInput.value.trim();
      if (!proxyApiKey) {
        throw new Error(t("proxyKeyRequired"));
      }

      const settings = await requestJson("/admin/settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ proxyApiKey })
      });
      proxyApiKeyInput.select();
      setProxyKeyStatus(t("proxyKeySaved") + " " + t("proxyKeyStatusAdmin").replace("{preview}", settings.proxyApiKeyPreview || ""), "ok");
    }

    async function logout() {
      await requestJson("/admin/logout", {
        method: "POST",
        headers: authHeaders()
      });
      location.href = "/admin/login";
    }

    function renderChannels(channels) {
      channelCount.textContent = String(channels.length);
      enabledCount.textContent = String(channels.filter((item) => item.enabled !== false).length);

      if (!channels.length) {
        channelRows.innerHTML = '<tr><td colspan="5" class="subtle">' + escapeHtml(t("noChannels")) + '</td></tr>';
        return;
      }

      const groups = [];
      const groupMap = new Map();
      channels.forEach((item) => {
        const groupId = normalizeBaseUrl(item && item.baseUrl) || String(item && item.name || item && item.id || "channel");
        if (!groupMap.has(groupId)) {
          const group = {
            name: item.name || item.id || "Channel",
            baseUrl: item.baseUrl || "",
            items: []
          };
          groups.push(group);
          groupMap.set(groupId, group);
        }
        groupMap.get(groupId).items.push(item);
      });

      channelRows.innerHTML = groups.map((group) => {
        const enabledInGroup = group.items.filter((item) => item.enabled !== false).length;
        const groupHeader = '<tr class="group-row"><td colspan="5">' +
          escapeHtml(group.name) +
          '<span class="group-meta"><span>' + group.items.length + ' ' + escapeHtml(t("accounts")) + '</span><span>' + enabledInGroup + ' ' + escapeHtml(t("enabledBadge")) + '</span><code>' + escapeHtml(group.baseUrl) + '</code></span>' +
        '</td></tr>';

        const rows = group.items.map((item) => {
        const models = Array.isArray(item.models) && item.models.length ? item.models.join(", ") : t("allModels");
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

        return groupHeader + rows;
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
      await loadSettings();

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

    function generateChannelsFromForm() {
      if (lastAppliedTemplateId !== templateSelect.value) {
        applyTemplateFields();
      }

      const channels = JSON.parse(editor.value);
      if (!Array.isArray(channels)) {
        throw new Error(t("invalidJson"));
      }

      const apiKeys = currentApiKeys();
      if (apiKeys.length === 0) {
        throw new Error(t("apiKeysRequired"));
      }

      const existingIds = new Set(channels.map((item) => item && item.id).filter(Boolean));
      const existingKeys = new Set(channels.map(channelFingerprint).filter((key) => key !== "::"));
      const pastedKeys = new Set();
      const prefix = channelIdPrefixInput.value.trim() || selectedTemplate().channel.id;
      const models = selectedModels();
      const baseUrl = channelBaseUrlInput.value.trim();
      let added = 0;
      let skipped = 0;

      apiKeys.forEach((apiKey, index) => {
        const fingerprint = normalizeBaseUrl(baseUrl) + "::" + apiKey;
        if (existingKeys.has(fingerprint) || pastedKeys.has(fingerprint)) {
          skipped += 1;
          return;
        }
        pastedKeys.add(fingerprint);

        let nextId = apiKeys.length === 1 ? prefix : prefix + "-" + (index + 1);
        let suffix = 2;
        while (existingIds.has(nextId)) {
          nextId = prefix + "-" + suffix;
          suffix += 1;
        }
        existingIds.add(nextId);
        existingKeys.add(fingerprint);
        added += 1;
        channels.push({
          id: nextId,
          name: channelNameInput.value.trim(),
          baseUrl,
          apiKey,
          enabled: channelEnabledInput.checked,
          models
        });
      });

      if (added === 0) {
        setStatus(t("noNewKeys"), "error");
        return;
      }

      editor.value = JSON.stringify(channels, null, 2);
      renderChannels(channels);
      channelApiKeysInput.value = "";
      setStatus(t("templateAdded").replace("{added}", added).replace("{skipped}", skipped), "ok");
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

    document.querySelector("#generateProxyKeyBtn").addEventListener("click", () => {
      if (!proxyApiKeyInput.value) {
        generateProxyApiKey();
      }
    });

    document.querySelector("#saveProxyKeyBtn").addEventListener("click", () => {
      saveProxyApiKey().catch((error) => setProxyKeyStatus(error.message, "error"));
    });

    document.querySelector("#saveBtn").addEventListener("click", () => {
      saveChannels().catch((error) => setStatus(error.message, "error"));
    });

    templateSelect.addEventListener("change", () => {
      applyTemplateFields();
    });

    document.querySelector("#generateChannelsBtn").addEventListener("click", () => {
      try {
        generateChannelsFromForm();
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    document.querySelector("#fetchModelsBtn").addEventListener("click", () => {
      fetchModels().catch((error) => setStatus(error.message, "error"));
    });

    modelSearchInput.addEventListener("input", () => {
      renderModelPicker(fetchedModels);
    });

    document.querySelector("#checkChannelsBtn").addEventListener("click", () => {
      checkChannels().catch((error) => setStatus(error.message, "error"));
    });

    document.querySelector("#logoutBtn").addEventListener("click", () => {
      logout().catch((error) => setStatus(error.message, "error"));
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
    function initializeAdmin() {
      templateSelect.innerHTML = channelTemplates.map((template) => '<option value="' + escapeHtml(template.id) + '">' + escapeHtml(template.label) + '</option>').join("");
      if (!channelTemplates.some((template) => template.id === templateSelect.value)) {
        templateSelect.value = channelTemplates[0].id;
      }
      applyTemplateFields();
      applyAdminLang();
      loadAll().catch((error) => setStatus(error.message, "error"));
    }

    initializeAdmin();
  </script>
</body>
</html>`;
}

function authPage(mode: "login" | "setup"): string {
  const isSetup = mode === "setup";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${isSetup ? "Setup Admin" : "Admin Login"}</title>
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

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: grid;
      place-items: center;
      padding: 24px;
    }

    .shell {
      width: min(440px, 100%);
      display: grid;
      gap: 14px;
    }

    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }

    .muted {
      color: var(--muted);
      font-size: 13px;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 20px;
      display: grid;
      gap: 14px;
    }

    label {
      display: grid;
      gap: 7px;
      color: var(--text);
      font-size: 13px;
      font-weight: 650;
    }

    input {
      width: 100%;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--text);
      padding: 0 11px;
      font: inherit;
      outline: none;
    }

    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(24, 106, 222, 0.12);
    }

    button,
    a.button {
      height: 40px;
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

    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }

    button.primary:hover {
      background: var(--accent-strong);
    }

    .row {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }

    .status {
      min-height: 38px;
      padding: 9px 11px;
      border-radius: 7px;
      background: #f2f5fa;
      color: var(--muted);
      font-size: 13px;
    }

    .status.ok { background: #eaf7f1; color: var(--ok); }
    .status.error { background: #fff0f0; color: var(--danger); }
  </style>
</head>
<body>
  <main class="shell">
    <div class="top">
      <div>
        <h1 data-i18n="${isSetup ? "setupTitle" : "loginTitle"}">${isSetup ? "Create admin account" : "Admin login"}</h1>
        <div class="muted" data-i18n="${isSetup ? "setupSub" : "loginSub"}">${isSetup ? "First run setup for this Worker." : "Sign in to manage channels."}</div>
      </div>
      <button id="langBtn" type="button">中文 / EN</button>
    </div>
    <section class="panel">
      <label>
        <span data-i18n="username">Username</span>
        <input id="username" type="text" autocomplete="username" placeholder="admin">
      </label>
      <label>
        <span data-i18n="password">Password</span>
        <input id="password" type="password" autocomplete="${isSetup ? "new-password" : "current-password"}" placeholder="${isSetup ? "At least 8 characters" : "Password"}">
      </label>
      <div class="row">
        <a class="button" href="/" data-i18n="home">Home</a>
        <button id="submitBtn" class="primary" type="button" data-i18n="${isSetup ? "create" : "login"}">${isSetup ? "Create account" : "Login"}</button>
      </div>
      <div id="status" class="status" data-i18n="${isSetup ? "setupHint" : "loginHint"}">${isSetup ? "Create the first admin account. It will be stored in KV." : "Use your admin username and password."}</div>
    </section>
  </main>

  <script>
    const messages = {
      en: {
        setupTitle: "Create admin account",
        setupSub: "First run setup for this Worker.",
        loginTitle: "Admin login",
        loginSub: "Sign in to manage channels.",
        username: "Username",
        password: "Password",
        home: "Home",
        create: "Create account",
        login: "Login",
        setupHint: "Create the first admin account. It will be stored in KV.",
        loginHint: "Use your admin username and password.",
        working: "Please wait...",
        ok: "Success. Opening admin...",
        failed: "Request failed"
      },
      zh: {
        setupTitle: "创建管理员账户",
        setupSub: "首次打开此 Worker 时需要初始化管理员。",
        loginTitle: "后台登录",
        loginSub: "登录后管理渠道配置。",
        username: "账号",
        password: "密码",
        home: "首页",
        create: "创建账户",
        login: "登录",
        setupHint: "创建第一个管理员账户，账号信息会保存到 KV。",
        loginHint: "使用管理员账号和密码登录。",
        working: "请稍候...",
        ok: "成功，正在打开后台...",
        failed: "请求失败"
      }
    };
    function storageGet(key) {
      try {
        return window.localStorage ? window.localStorage.getItem(key) : null;
      } catch {
        return null;
      }
    }

    function storageSet(key, value) {
      try {
        if (window.localStorage) window.localStorage.setItem(key, value);
      } catch {}
    }

    let lang = storageGet("routerLang") || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
    const mode = "${mode}";
    const statusBox = document.querySelector("#status");

    function t(key) {
      return messages[lang][key] || messages.en[key] || key;
    }

    function applyLang() {
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      document.querySelectorAll("[data-i18n]").forEach((node) => {
        const key = node.getAttribute("data-i18n");
        node.textContent = t(key);
      });
      storageSet("routerLang", lang);
    }

    function setStatus(message, type = "") {
      statusBox.textContent = message;
      statusBox.className = "status" + (type ? " " + type : "");
    }

    async function submit() {
      setStatus(t("working"));
      const response = await fetch(mode === "setup" ? "/admin/setup" : "/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.querySelector("#username").value.trim(),
          password: document.querySelector("#password").value
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || t("failed"));
      }
      setStatus(t("ok"), "ok");
      location.href = "/admin";
    }

    document.querySelector("#langBtn").addEventListener("click", () => {
      lang = lang === "zh" ? "en" : "zh";
      applyLang();
    });
    document.querySelector("#submitBtn").addEventListener("click", () => submit().catch((error) => setStatus(error.message, "error")));
    document.querySelector("#password").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit().catch((error) => setStatus(error.message, "error"));
    });
    applyLang();
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

    function storageGet(key) {
      try {
        return window.localStorage ? window.localStorage.getItem(key) : null;
      } catch {
        return null;
      }
    }

    function storageSet(key, value) {
      try {
        if (window.localStorage) window.localStorage.setItem(key, value);
      } catch {}
    }

    let lang = storageGet("routerLang") || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
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
      storageSet("routerLang", lang);
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
