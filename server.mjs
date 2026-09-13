import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig, assertProductionConfig } from "./lib/config.mjs";
import { PostgresStore, MemoryStore } from "./lib/db.mjs";
import { cookie, decryptSecret, encryptSecret, hashPassword, hashToken, parseCookies, randomSecret, safeEqualText, verifyPassword } from "./lib/security.mjs";
import { ThreeXuiClient, resetDays } from "./lib/three-x-ui.mjs";
import { HappClient, encodeAnnouncement, hashDomain, subscriptionUserinfo } from "./lib/happ.mjs";
import { DARK_THEME } from "./lib/theme.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const SESSION_DAYS = 2;
const MAX_BODY = 64 * 1024;
const loginAttempts = new Map();

function jsonSafe(value) { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? Number(item) : item)); }
function sendJson(res, status, body, headers = {}) { const payload = JSON.stringify(jsonSafe(body)); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(payload); }
function sendText(res, status, text, headers = {}) { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(text); }
function noStore(res) { res.setHeader("cache-control", "no-store"); }
function isSecure(req) { return req.headers["x-forwarded-proto"] === "https"; }
function publicUrl(config, req, token, installCode = "", title = "") { const base = config.publicBaseUrl || `${isSecure(req) ? "https" : "http"}://${req.headers.host}`; const url = `${base}/s/${token}`; return installCode ? `${url}#${encodeURIComponent(title)}?installid=${encodeURIComponent(installCode)}` : url; }
function getRoute(pathname, pattern) { const match = pattern.exec(pathname); return match || null; }
function validUrl(value) { if (!value) return true; try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } }

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error("Request body is too large."); chunks.push(chunk); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeSubscriptionInput(body) {
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const traffic = body.trafficUnlimited ? 0 : Number(body.trafficGb);
  const days = body.daysUnlimited ? 0 : Number(body.days);
  const deviceLimit = body.devicesUnlimited ? 0 : Number(body.deviceLimit);
  const ipLimit = body.ipUnlimited ? 0 : Number(body.ipLimit);
  const resetPeriod = ["never", "daily", "weekly", "monthly"].includes(body.resetPeriod) ? body.resetPeriod : "never";
  if (!name || name.length > 25) throw new Error("Название обязательно и должно быть не длиннее 25 символов.");
  if (description.length > 200) throw new Error("Описание не должно быть длиннее 200 символов.");
  if (!body.trafficUnlimited && (!Number.isFinite(traffic) || traffic <= 0 || traffic > 1000000)) throw new Error("Укажите трафик от 0.01 до 1000000 ГБ или выберите безлимит.");
  if (!body.daysUnlimited && (!Number.isInteger(days) || days <= 0 || days > 36500)) throw new Error("Укажите срок от 1 до 36500 дней или выберите безлимит.");
  if (!body.devicesUnlimited && (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > 100)) throw new Error("Лимит устройств должен быть от 1 до 100.");
  if (!body.ipUnlimited && (!Number.isInteger(ipLimit) || ipLimit < 1 || ipLimit > 100)) throw new Error("Лимит IP должен быть от 1 до 100.");
  if (!validUrl(body.supportUrl)) throw new Error("Ссылка поддержки должна быть корректным HTTP(S)-адресом.");
  return { name, description, trafficLimitBytes: body.trafficUnlimited ? 0 : Math.round(traffic * 1024 ** 3), expiresAt: body.daysUnlimited ? null : new Date(Date.now() + days * 86400000).toISOString(), deviceLimit: body.devicesUnlimited ? 0 : deviceLimit, ipLimit: body.ipUnlimited ? 0 : ipLimit, resetPeriod, supportUrl: String(body.supportUrl || "").trim() };
}

function dto(row, req, config) {
  const expiresAt = row.expires_at || row.expiresAt || null;
  const expired = expiresAt && new Date(expiresAt) <= new Date();
  return { id: row.id, name: row.name, description: row.description, status: expired && row.status === "active" ? "expired" : row.status, trafficLimitBytes: Number(row.traffic_limit_bytes ?? row.trafficLimitBytes ?? 0), usedTrafficBytes: Number(row.used_upload_bytes ?? 0) + Number(row.used_download_bytes ?? 0), expiresAt, deviceLimit: Number(row.device_limit ?? row.deviceLimit ?? 0), ipLimit: Number(row.ip_limit ?? row.ipLimit ?? 0), resetPeriod: row.reset_period ?? row.resetPeriod ?? "never", supportUrl: row.support_url ?? row.supportUrl ?? "", deviceCount: Number(row.device_count ?? 0), tokenPreview: row.public_token_preview ?? row.publicTokenPreview, url: row.public_token_ciphertext && config.sessionSecret ? publicUrl(config, req, decryptSecret(row.public_token_ciphertext, config.sessionSecret), row.install_code ?? row.installCode, row.name) : undefined, createdAt: row.created_at ?? row.createdAt, updatedAt: row.updated_at ?? row.updatedAt };
}

async function syncSubscription(row, store, threeXui, happ) {
  let traffic = { upload: Number(row.used_upload_bytes || 0), download: Number(row.used_download_bytes || 0) };
  if (row.three_xui_email && threeXui) try { const response = await threeXui.traffic(row.three_xui_email); const data = response?.obj || response || {}; traffic = { upload: Number(data.up || data.upload || 0), download: Number(data.down || data.download || 0) }; await store.updateSync(row.id, traffic); } catch { /* stale statistics are safer than breaking a valid subscription */ }
  if (row.install_code && row.device_limit > 0 && happ) {
    try { const response = await happ.listHwid(row.install_code); const entries = response?.data || response?.obj || []; const devices = entries.map((device) => ({ hwid: device.hwid || device.HWID || String(device), os: device.os || device.platform || device.device_name || "", firstSeen: device.created_at || device.first_seen || device.date, lastSeen: device.updated_at || device.last_seen || device.date })); await store.upsertDevices(row.id, devices); } catch { /* Happ telemetry can be temporarily unavailable */ }
  }
  return traffic;
}

function activeHappStatus(status) { return status === "active" ? 10 : 5; }

function explainHappError(error) {
  const message = String(error?.message || error || "Ошибка Happ API");
  if (/HAPP_AUTH_KEY/i.test(message)) return message;
  if (/active subscription/i.test(message)) return "Happ API отклонил запрос: для Limited Links/API нужна активная подписка провайдера на happ-proxy.com. Подписка в приложении Happ не заменяет подписку провайдера.";
  if (/auth error/i.test(message)) return "Happ API отклонил ключ. Проверь HAPP_PROVIDER_ID и HAPP_AUTH_KEY в Render: Provider ID — 8 символов, auth_key — 32 символа.";
  return `Happ API: ${message}`;
}

function requireAuth(store, config, req) {
  const cookies = parseCookies(req.headers.cookie); return store.getSession(cookies.session).then((session) => session ? { session, cookies } : null);
}

function requireCsrf(req, auth) { const header = req.headers["x-csrf-token"]; if (!header || !safeEqualText(header, auth.cookies.csrf)) throw new Error("CSRF validation failed."); }

export function createApp({ config = loadConfig(), store, threeXui, happ, fetchImpl = globalThis.fetch } = {}) {
  const actualStore = store || new PostgresStore(config.databaseUrl);
  const xui = threeXui || new ThreeXuiClient({ ...config.threeXui, fetchImpl });
  const happClient = happ || new HappClient({ ...config.happ, fetchImpl });
  const app = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, "http://localhost");
      const pathname = requestUrl.pathname;
      if (req.method === "GET" && pathname === "/healthz") { res.writeHead(204, { "cache-control": "no-store" }); res.end(); return; }
      if (req.method === "GET" && pathname === "/api/qr") { const auth = await requireAuth(actualStore, config, req); if (!auth) return sendJson(res, 401, { error: "Unauthorized" }); const text = requestUrl.searchParams.get("text"); if (!text || text.length > 2048) return sendJson(res, 400, { error: "Invalid QR text" }); const { default: QRCode } = await import("qrcode"); const png = await QRCode.toBuffer(text, { type: "png", width: 260, margin: 2, color: { dark: "#E9EEF2", light: "#11161B" } }); res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=300" }); res.end(png); return; }
      if (req.method === "GET" && pathname === "/api/auth/me") { const auth = await requireAuth(actualStore, config, req); return auth ? sendJson(res, 200, { username: auth.session.username, mustChangePassword: auth.session.must_change_password }) : sendJson(res, 401, { error: "Unauthorized" }); }
      if (req.method === "POST" && pathname === "/api/auth/login") {
        const ip = req.socket.remoteAddress || "unknown"; const now = Date.now(); const attempt = loginAttempts.get(ip) || { count: 0, at: now }; if (now - attempt.at > 60000) { attempt.count = 0; attempt.at = now; } if (attempt.count >= 10) return sendJson(res, 429, { error: "Слишком много попыток. Повторите позже." });
        const body = await readBody(req); const user = await actualStore.getAdmin(String(body.username || "")); const valid = user && await verifyPassword(String(body.password || ""), user.password_hash); if (!valid) { attempt.count += 1; loginAttempts.set(ip, attempt); return sendJson(res, 401, { error: "Неверный логин или пароль." }); }
        loginAttempts.delete(ip); const sessionToken = randomSecret(); const csrfToken = randomSecret(24); await actualStore.createSession(user.id, sessionToken, csrfToken, new Date(Date.now() + SESSION_DAYS * 86400000)); const secure = isSecure(req); res.setHeader("set-cookie", [cookie("session", sessionToken, { httpOnly: true, secure, maxAge: SESSION_DAYS * 86400 }), cookie("csrf", csrfToken, { secure, maxAge: SESSION_DAYS * 86400 })]); return sendJson(res, 200, { username: user.username, mustChangePassword: user.must_change_password });
      }
      if (req.method === "POST" && pathname === "/api/auth/change-password") {
        const auth = await requireAuth(actualStore, config, req); if (!auth) return sendJson(res, 401, { error: "Unauthorized" }); requireCsrf(req, auth); const body = await readBody(req); const password = String(body.password || ""); if (password.length < 10) return sendJson(res, 400, { error: "Пароль должен содержать минимум 10 символов." }); await actualStore.changePassword(auth.session.user_id, await hashPassword(password)); await actualStore.audit("password_changed", "admin", auth.session.user_id); return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && pathname === "/api/auth/logout") { const auth = await requireAuth(actualStore, config, req); if (auth) { requireCsrf(req, auth); await actualStore.deleteSession(auth.cookies.session); } res.setHeader("set-cookie", [cookie("session", "", { httpOnly: true, secure: isSecure(req), maxAge: 0 }), cookie("csrf", "", { secure: isSecure(req), maxAge: 0 })]); return sendJson(res, 200, { ok: true }); }

      if (pathname.startsWith("/api/")) {
        const auth = await requireAuth(actualStore, config, req); if (!auth) return sendJson(res, 401, { error: "Unauthorized" });
        if (auth.session.must_change_password && pathname !== "/api/auth/me") return sendJson(res, 403, { code: "PASSWORD_CHANGE_REQUIRED", error: "Сначала смените пароль." });
        if (["POST", "PATCH", "DELETE"].includes(req.method)) requireCsrf(req, auth);
        if (req.method === "GET" && pathname === "/api/dashboard") return sendJson(res, 200, await actualStore.dashboard());
        if (req.method === "GET" && pathname === "/api/subscriptions") { const rows = await actualStore.listSubscriptions(); for (const row of rows) await syncSubscription(row, actualStore, xui, happClient); return sendJson(res, 200, (await actualStore.listSubscriptions()).map((row) => dto(row, req, config))); }
        if (req.method === "POST" && pathname === "/api/subscriptions") {
          const input = normalizeSubscriptionInput(await readBody(req)); const rawToken = randomSecret(); const email = `vpn-${randomUUID().slice(0, 12)}`; const subId = randomSecret(18); let clientCreated = false; let happInstallCreated = null;
          try {
            const advancedMode = Boolean(config.threeXui.baseUrl && config.threeXui.inboundIds.length);
            let subscriptionUrl = config.legacyUpstreamUrl;
            let clientEmail = null;
            let installCode = null;
            let installId = null;
            if (advancedMode) {
              await xui.addClient({ email, subId, totalGB: input.trafficLimitBytes, expiryTime: input.expiresAt ? new Date(input.expiresAt).getTime() : 0, limitIp: input.ipLimit, reset: resetDays(input.resetPeriod) });
              clientCreated = true;
              subscriptionUrl = await xui.getSubscriptionUrl(email, subId);
              clientEmail = email;
            }
            if (input.deviceLimit > 0) {
              if (!config.happ.authKey) throw new Error("Для лимита устройств заполните HAPP_AUTH_KEY в Render.");
              const install = await happClient.createInstallLink(input.deviceLimit, input.name);
              installCode = install.install_code;
              installId = install.id;
              happInstallCreated = installId;
              if (!installCode) throw new Error("Happ API не вернул install_code.");
            }
            if (!subscriptionUrl) throw new Error("Укажите UPSTREAM_SUBSCRIPTION_URL или настройте 3x-ui.");
            const row = await actualStore.insertSubscription({ ...input, email: clientEmail, subId, subscriptionUrl, installCode, installId, publicTokenHash: hashToken(rawToken), publicTokenPreview: rawToken.slice(-8), publicTokenCiphertext: encryptSecret(rawToken, config.sessionSecret), inboundIds: config.threeXui.inboundIds }, { email: clientEmail, subId });
            await actualStore.audit("subscription_created", "subscription", row.id, { name: input.name, mode: advancedMode ? "3x-ui" : "simple", happLimited: Boolean(installCode) });
            return sendJson(res, 201, { subscription: dto(row, req, config), url: publicUrl(config, req, rawToken, installCode, input.name) });
          } catch (error) {
            if (happInstallCreated && config.happ.authKey) await happClient.updateInstall(happInstallCreated, { status: 5 }).catch(() => {});
            if (clientCreated) await xui.deleteClient(email).catch(() => {});
            const message = error?.message || "Не удалось создать подписку.";
            return sendJson(res, /Happ|HAPP|устройств/i.test(message) ? 400 : 502, { error: /Happ|HAPP|устройств/i.test(message) ? explainHappError(error) : message });
          }
        }
        const subMatch = getRoute(pathname, /^\/api\/subscriptions\/([^/]+)$/);
        const actionMatch = getRoute(pathname, /^\/api\/subscriptions\/([^/]+)\/(enable|disable|rotate|devices)$/);
        if (req.method === "GET" && subMatch) { const row = await actualStore.getSubscriptionById(subMatch[1]); if (!row) return sendJson(res, 404, { error: "Подписка не найдена." }); await syncSubscription(row, actualStore, xui, happClient); const fresh = await actualStore.getSubscriptionById(row.id); return sendJson(res, 200, { subscription: dto(fresh, req, config), devices: (await actualStore.listDevices(row.id)).map(jsonSafe) }); }
        if (actionMatch && actionMatch[2] === "devices" && req.method === "GET") { const row = await actualStore.getSubscriptionById(actionMatch[1]); if (!row) return sendJson(res, 404, { error: "Подписка не найдена." }); await syncSubscription(row, actualStore, xui, happClient); return sendJson(res, 200, { devices: await actualStore.listDevices(row.id) }); }
        if (actionMatch && ["enable", "disable"].includes(actionMatch[2]) && req.method === "POST") { const row = await actualStore.getSubscriptionById(actionMatch[1]); if (!row) return sendJson(res, 404, { error: "Подписка не найдена." }); const status = actionMatch[2] === "enable" ? "active" : "disabled"; if (row.three_xui_email) await xui.updateClient(row.three_xui_email, { email: row.three_xui_email, totalGB: row.traffic_limit_bytes, expiryTime: row.expires_at ? new Date(row.expires_at).getTime() : 0, limitIp: row.ip_limit, enable: status === "active" }); if (row.install_id) { if (!config.happ.authKey) return sendJson(res, 400, { error: "Для управления лимитом устройств заполните HAPP_AUTH_KEY в Render." }); await happClient.updateInstall(row.install_id, { status: activeHappStatus(status), note: row.name }); } const updated = await actualStore.setSubscriptionStatus(row.id, status); await actualStore.audit(`${status}_subscription`, "subscription", row.id); return sendJson(res, 200, { subscription: dto(updated, req, config) }); }
        if (actionMatch && actionMatch[2] === "rotate" && req.method === "POST") { const row = await actualStore.getSubscriptionById(actionMatch[1]); if (!row) return sendJson(res, 404, { error: "Подписка не найдена." }); const raw = randomSecret(); const updated = await actualStore.rotateToken(row.id, hashToken(raw), raw.slice(-8), encryptSecret(raw, config.sessionSecret)); await actualStore.audit("subscription_token_rotated", "subscription", row.id); return sendJson(res, 200, { subscription: dto(updated, req, config), url: publicUrl(config, req, raw, row.install_code, row.name) }); }
        if (req.method === "PATCH" && subMatch) {
          const row = await actualStore.getSubscriptionById(subMatch[1]); if (!row) return sendJson(res, 404, { error: "Подписка не найдена." });
          const input = normalizeSubscriptionInput(await readBody(req));
          if (row.three_xui_email) { const client = await xui.getClient(row.three_xui_email); const current = client?.obj?.client || client?.client || {}; await xui.updateClient(row.three_xui_email, { ...current, email: row.three_xui_email, totalGB: input.trafficLimitBytes, expiryTime: input.expiresAt ? new Date(input.expiresAt).getTime() : 0, limitIp: input.ipLimit, reset: resetDays(input.resetPeriod), enable: row.status === "active" }); }
          let installCode = row.install_code;
          let installId = row.install_id;
          if (input.deviceLimit > 0) {
            if (!config.happ.authKey) return sendJson(res, 400, { error: "Для лимита устройств заполните HAPP_AUTH_KEY в Render." });
            if (row.install_id) await happClient.updateInstall(row.install_id, { install_limit: input.deviceLimit, status: activeHappStatus(row.status), note: input.name });
            else { const install = await happClient.createInstallLink(input.deviceLimit, input.name); installCode = install.install_code; installId = install.id; if (!installCode) throw new Error("Happ API не вернул install_code."); }
          } else if (row.install_id) {
            if (!config.happ.authKey) return sendJson(res, 400, { error: "Для отключения старого лимита устройств нужен HAPP_AUTH_KEY в Render." });
            await happClient.updateInstall(row.install_id, { status: 5, note: input.name });
            installCode = null;
            installId = null;
          }
          const updated = await actualStore.updateSubscription(row.id, input, { installCode, installId }); await actualStore.audit("subscription_updated", "subscription", row.id); return sendJson(res, 200, { subscription: dto(updated, req, config) });
        }
        const deviceMatch = getRoute(pathname, /^\/api\/subscriptions\/([^/]+)\/devices\/(.+)$/); if (req.method === "DELETE" && deviceMatch) { const row = await actualStore.getSubscriptionById(deviceMatch[1]); if (!row) return sendJson(res, 404, { error: "Подписка не найдена." }); const hwid = decodeURIComponent(deviceMatch[2]); if (row.install_code) await happClient.deleteHwid(row.install_code, hwid); await actualStore.deleteDevice(row.id, hwid); await actualStore.audit("device_deleted", "subscription", row.id, { hwid: hwid.slice(0, 8) }); return sendJson(res, 200, { ok: true }); }
        if (req.method === "GET" && pathname === "/api/settings") return sendJson(res, 200, { providerId: config.happ.providerId, hasHappAuthKey: Boolean(config.happ.authKey), hasDatabase: Boolean(config.databaseUrl), hasThreeXui: Boolean(config.threeXui.baseUrl), inboundIds: config.threeXui.inboundIds, publicBaseUrl: config.publicBaseUrl, settings: await actualStore.getSettings() });
        if (req.method === "PATCH" && pathname === "/api/settings") { const body = await readBody(req); const allowed = {}; if (body.defaultSupportUrl !== undefined && validUrl(body.defaultSupportUrl)) allowed.defaultSupportUrl = String(body.defaultSupportUrl); if (body.domainName !== undefined) allowed.domainName = String(body.domainName).trim().slice(0, 255); await actualStore.setSettings(allowed); await actualStore.audit("settings_updated", "settings", null, allowed); return sendJson(res, 200, { settings: await actualStore.getSettings() }); }
        if (req.method === "POST" && pathname === "/api/settings/register-domain") { const host = new URL(config.publicBaseUrl || `http://${req.headers.host}`).hostname; const response = await happClient.addDomain(hashDomain(host), host); await actualStore.setSettings({ domainName: host, domainHash: hashDomain(host) }); await actualStore.audit("domain_registered", "settings", null, { host }); return sendJson(res, 200, { host, domainHash: hashDomain(host), response }); }
        if (req.method === "GET" && pathname === "/api/system/status") { const status = { database: "ok", threeXui: config.threeXui.baseUrl ? "unknown" : "not configured", happ: config.happ.authKey ? "unknown" : "not configured" }; if (config.threeXui.baseUrl) try { await xui.onlineClients(); status.threeXui = "ok"; } catch (error) { status.threeXui = error.message; } if (config.happ.authKey) try { await happClient.listDomains(); status.happ = "ok"; } catch (error) { status.happ = error.message; } return sendJson(res, 200, status); }
        return sendJson(res, 404, { error: "Маршрут не найден." });
      }

      const publicMatch = getRoute(pathname, /^\/s\/([^/]+)$/); if (req.method === "GET" && publicMatch) { const row = await actualStore.getSubscriptionByTokenHash(hashToken(publicMatch[1])); if (!row || row.status !== "active" || (row.expires_at && new Date(row.expires_at) <= new Date())) return sendText(res, 404, ""); const traffic = await syncSubscription(row, actualStore, xui, happClient); const fresh = await actualStore.getSubscriptionById(row.id); const upstream = fresh.three_xui_subscription_url || config.legacyUpstreamUrl; if (!upstream) return sendText(res, 502, "Subscription source is temporarily unavailable."); const source = await fetchImpl(upstream, { redirect: "follow", headers: { accept: "text/plain, application/json, */*", "user-agent": "VPN-Panel/1.0" }, signal: AbortSignal.timeout(15000) }); if (!source.ok) return sendText(res, 502, "Subscription source is temporarily unavailable."); const body = Buffer.from(await source.arrayBuffer()); if (!body.length || body.length > 5 * 1024 * 1024) return sendText(res, 502, "Subscription source is temporarily unavailable."); const announce = encodeAnnouncement(fresh.description); const headers = { "content-type": source.headers.get("content-type") || "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${fresh.name.replace(/[^a-z0-9_-]+/gi, "-")}.txt"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff", providerid: config.happ.providerId, "profile-title": fresh.name, "profile-update-interval": "1", "subscription-auto-update-enable": "1", "subscription-auto-update-open-enable": "1", "subscription-pin": "1", "subscriptions-collapse": "0", "subscriptions-expand-now": "1", "subscription-ping-onopen-enabled": "1", "subscriptions-sort-type": "ping", announce, "subscription-userinfo": subscriptionUserinfo({ upload: traffic.upload, download: traffic.download, total: fresh.traffic_limit_bytes, expiresAt: fresh.expires_at }), "color-profile": JSON.stringify(DARK_THEME) }; res.writeHead(200, headers); res.end(body); return; }
      if (req.method === "GET" && pathname === "/" || req.method === "GET" && pathname === "/index.html") { const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html")); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); return; }
      if (req.method === "GET" && ["/styles.css", "/app.js"].includes(pathname)) { const file = await fs.readFile(path.join(PUBLIC_DIR, pathname.slice(1))); res.writeHead(200, { "content-type": pathname.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8" }); res.end(file); return; }
      sendText(res, 404, "Not found");
    } catch (error) { const message = error?.message || "Request failed."; sendJson(res, 400, { error: /active subscription|auth error|Happ API/i.test(message) ? explainHappError(error) : message }); }
  });
  app.store = actualStore; app.config = config; return app;
}

export async function start() {
  const config = loadConfig(); assertProductionConfig(config); const store = new PostgresStore(config.databaseUrl); await store.init(); const app = createApp({ config, store }); app.listen(config.port, "0.0.0.0", () => console.log(`VPN panel is listening on ${config.port}.`)); return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { start().catch((error) => { console.error(`Startup error: ${error.message}`); process.exitCode = 1; }); }
