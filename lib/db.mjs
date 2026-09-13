import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashPassword, hashToken } from "./security.mjs";

export class PostgresStore {
  constructor(databaseUrl) {
    if (!databaseUrl) throw new Error("DATABASE_URL is required.");
    const isLocal = /localhost|127\.0\.0\.1/.test(databaseUrl);
    this.pool = null;
    this.poolOptions = { connectionString: databaseUrl, ssl: isLocal ? false : { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30_000 };
  }

  async close() { if (this.pool) await this.pool.end(); }

  async init() {
    const { default: pg } = await import("pg");
    this.pool = new pg.Pool(this.poolOptions);
    const schema = await fs.readFile(path.join(process.cwd(), "schema.sql"), "utf8");
    await this.pool.query(schema);
    const existing = await this.pool.query("select id from admin_users limit 1");
    if (!existing.rowCount) {
      await this.pool.query("insert into admin_users (username, password_hash, must_change_password) values ($1, $2, true)", ["admin", await hashPassword("admin")]);
    }
  }

  async query(text, values) { return this.pool.query(text, values); }

  async getAdmin(username) {
    const result = await this.query("select * from admin_users where username = $1", [username]);
    return result.rows[0] || null;
  }

  async changePassword(userId, passwordHash) {
    await this.query("update admin_users set password_hash = $1, must_change_password = false, updated_at = now() where id = $2", [passwordHash, userId]);
  }

  async createSession(userId, rawToken, csrfToken, expiresAt) {
    await this.query("insert into sessions (token_hash, user_id, csrf_token_hash, expires_at) values ($1, $2, $3, $4)", [hashToken(rawToken), userId, hashToken(csrfToken), expiresAt]);
  }

  async getSession(rawToken) {
    const result = await this.query("select s.*, u.username, u.must_change_password from sessions s join admin_users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()", [hashToken(rawToken)]);
    return result.rows[0] || null;
  }

  async deleteSession(rawToken) { await this.query("delete from sessions where token_hash = $1", [hashToken(rawToken)]); }

  async listSubscriptions() {
    const result = await this.query(`select s.*, coalesce(d.device_count, 0) as device_count
      from subscriptions s
      left join (select subscription_id, count(*) filter (where active) as device_count from subscription_devices group by subscription_id) d on d.subscription_id = s.id
      order by s.created_at desc`);
    return result.rows;
  }

  async getSubscriptionById(id) {
    const result = await this.query("select * from subscriptions where id = $1", [id]);
    return result.rows[0] || null;
  }

  async getSubscriptionByTokenHash(tokenHashValue) {
    const result = await this.query("select * from subscriptions where public_token_hash = $1", [tokenHashValue]);
    return result.rows[0] || null;
  }

  async insertSubscription(input, clientData) {
    const result = await this.query(`insert into subscriptions
      (name, description, traffic_limit_bytes, expires_at, device_limit, ip_limit, reset_period, support_url, public_token_hash, public_token_preview, public_token_ciphertext, install_code, install_id, three_xui_email, three_xui_sub_id, three_xui_subscription_url)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`, [
      input.name, input.description, input.trafficLimitBytes, input.expiresAt, input.deviceLimit, input.ipLimit, input.resetPeriod, input.supportUrl,
      input.publicTokenHash, input.publicTokenPreview, input.publicTokenCiphertext, input.installCode, input.installId, input.email, input.subId, input.subscriptionUrl
    ]);
    const row = result.rows[0];
    if (input.email) await this.query("insert into subscription_clients (subscription_id, panel_email, inbound_ids, client_data) values ($1,$2,$3,$4)", [row.id, input.email, JSON.stringify(input.inboundIds || []), JSON.stringify(clientData || {})]);
    return row;
  }

  async updateSubscription(id, input, integration = {}) {
    const result = await this.query(`update subscriptions set name=$1, description=$2, traffic_limit_bytes=$3, expires_at=$4, device_limit=$5, ip_limit=$6, reset_period=$7, support_url=$8, install_code=$9, install_id=$10, updated_at=now() where id=$11 returning *`, [input.name, input.description, input.trafficLimitBytes, input.expiresAt, input.deviceLimit, input.ipLimit, input.resetPeriod, input.supportUrl, integration.installCode ?? null, integration.installId ?? null, id]);
    return result.rows[0] || null;
  }

  async clearHappInstall(id) {
    await this.query("update subscriptions set install_code=null, install_id=null, updated_at=now() where id=$1", [id]);
  }

  async getClientRecord(id) {
    const result = await this.query("select * from subscription_clients where subscription_id=$1 limit 1", [id]);
    return result.rows[0] || null;
  }

  async setSubscriptionStatus(id, status) {
    const result = await this.query("update subscriptions set status=$1, updated_at=now() where id=$2 returning *", [status, id]);
    return result.rows[0] || null;
  }

  async rotateToken(id, tokenHashValue, preview, ciphertext) {
    const result = await this.query("update subscriptions set public_token_hash=$1, public_token_preview=$2, public_token_ciphertext=$3, updated_at=now() where id=$4 returning *", [tokenHashValue, preview, ciphertext, id]);
    return result.rows[0] || null;
  }

  async updateSync(id, traffic) {
    await this.query("update subscriptions set used_upload_bytes=$1, used_download_bytes=$2, last_synced_at=now(), updated_at=now() where id=$3", [traffic.upload || 0, traffic.download || 0, id]);
  }

  async listDevices(id) {
    const result = await this.query("select * from subscription_devices where subscription_id=$1 order by last_seen desc", [id]);
    return result.rows;
  }

  async upsertDevices(id, devices) {
    for (const device of devices) {
      await this.query(`insert into subscription_devices (subscription_id, hwid, os, first_seen, last_seen, active)
        values ($1,$2,$3,coalesce($4,now()),coalesce($5,now()),true)
        on conflict (subscription_id, hwid) do update set os=excluded.os, last_seen=excluded.last_seen, active=true`, [id, device.hwid, device.os || "", device.firstSeen || null, device.lastSeen || null]);
    }
  }

  async deleteDevice(id, hwid) {
    await this.query("update subscription_devices set active=false where subscription_id=$1 and hwid=$2", [id, hwid]);
  }

  async getSettings() {
    const result = await this.query("select key, value from settings order by key");
    return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  }

  async setSettings(entries) {
    for (const [key, value] of Object.entries(entries)) await this.query("insert into settings(key,value,updated_at) values($1,$2,now()) on conflict(key) do update set value=excluded.value,updated_at=now()", [key, JSON.stringify(value)]);
  }

  async audit(action, entityType, entityId, details = {}) {
    await this.query("insert into audit_logs(action, entity_type, entity_id, details) values($1,$2,$3,$4)", [action, entityType, entityId || null, JSON.stringify(details)]);
  }

  async dashboard() {
    const result = await this.query(`select
      count(*) filter (where status='active' and (expires_at is null or expires_at > now()))::int as active,
      count(*) filter (where status='disabled')::int as disabled,
      count(*) filter (where status='expired' or expires_at <= now())::int as expired,
      coalesce(sum(used_upload_bytes + used_download_bytes),0)::bigint as traffic_bytes,
      (select count(*) from subscription_devices where active)::int as devices
      from subscriptions`);
    return result.rows[0];
  }
}

export class MemoryStore {
  constructor() { this.users = [{ id: "admin", username: "admin", password_hash: null, must_change_password: true }]; this.sessions = new Map(); this.subscriptions = []; this.devices = []; this.settings = {}; this.auditLogs = []; }
  async init() { if (!this.users[0].password_hash) this.users[0].password_hash = await hashPassword("admin"); }
  async close() {}
  async getAdmin(username) { return this.users.find((u) => u.username === username) || null; }
  async changePassword(id, hash) { const u = this.users.find((x) => x.id === id); u.password_hash = hash; u.must_change_password = false; }
  async createSession(userId, raw, csrf, expiresAt) { this.sessions.set(hashToken(raw), { user_id: userId, csrf_token_hash: hashToken(csrf), expires_at: new Date(expiresAt), username: "admin", must_change_password: this.users[0].must_change_password }); }
  async getSession(raw) { const s = this.sessions.get(hashToken(raw)); return s && s.expires_at > new Date() ? { ...s, must_change_password: this.users.find((u) => u.id === s.user_id)?.must_change_password ?? true } : null; }
  async deleteSession(raw) { this.sessions.delete(hashToken(raw)); }
  async listSubscriptions() { return this.subscriptions.map((s) => ({ ...s, device_count: this.devices.filter((d) => d.subscription_id === s.id && d.active).length })); }
  async getSubscriptionById(id) { return this.subscriptions.find((s) => s.id === id) || null; }
  async getSubscriptionByTokenHash(h) { return this.subscriptions.find((s) => s.public_token_hash === h) || null; }
  async insertSubscription(input) { const row = { id: randomUUID(), ...input, public_token_hash: input.publicTokenHash, public_token_preview: input.publicTokenPreview, public_token_ciphertext: input.publicTokenCiphertext, install_code: input.installCode, install_id: input.installId, three_xui_email: input.email, three_xui_sub_id: input.subId, three_xui_subscription_url: input.subscriptionUrl, traffic_limit_bytes: input.trafficLimitBytes, expires_at: input.expiresAt, device_limit: input.deviceLimit, ip_limit: input.ipLimit, reset_period: input.resetPeriod, support_url: input.supportUrl, status: "active", used_upload_bytes: 0, used_download_bytes: 0 }; this.subscriptions.push(row); return row; }
  async updateSubscription(id, input, integration = {}) { const s = await this.getSubscriptionById(id); Object.assign(s, input); if (integration.installCode !== undefined && integration.installCode !== null) s.install_code = integration.installCode; if (integration.installId !== undefined && integration.installId !== null) s.install_id = integration.installId; if (integration.installCode === null) s.install_code = null; if (integration.installId === null) s.install_id = null; return s; }
  async clearHappInstall(id) { const s = await this.getSubscriptionById(id); if (s) { s.install_code = null; s.install_id = null; } }
  async setSubscriptionStatus(id, status) { const s = await this.getSubscriptionById(id); s.status = status; return s; }
  async rotateToken(id, h, preview, ciphertext) { const s = await this.getSubscriptionById(id); Object.assign(s, { public_token_hash: h, public_token_preview: preview, public_token_ciphertext: ciphertext }); return s; }
  async updateSync(id, traffic) { const s = await this.getSubscriptionById(id); Object.assign(s, { used_upload_bytes: traffic.upload || 0, used_download_bytes: traffic.download || 0 }); }
  async listDevices(id) { return this.devices.filter((d) => d.subscription_id === id); }
  async upsertDevices(id, devices) { for (const d of devices) { const existing = this.devices.find((x) => x.subscription_id === id && x.hwid === d.hwid); if (existing) Object.assign(existing, d, { active: true }); else this.devices.push({ id: randomUUID(), subscription_id: id, ...d, active: true }); } }
  async deleteDevice(id, hwid) { const d = this.devices.find((x) => x.subscription_id === id && x.hwid === hwid); if (d) d.active = false; }
  async getSettings() { return this.settings; }
  async setSettings(entries) { Object.assign(this.settings, entries); }
  async audit(action, entityType, entityId, details) { this.auditLogs.push({ action, entityType, entityId, details }); }
  async dashboard() { const active = this.subscriptions.filter((s) => s.status === "active").length; return { active, disabled: this.subscriptions.filter((s) => s.status === "disabled").length, expired: this.subscriptions.filter((s) => s.status === "expired").length, traffic_bytes: this.subscriptions.reduce((n, s) => n + Number(s.used_upload_bytes || 0) + Number(s.used_download_bytes || 0), 0), devices: this.devices.filter((d) => d.active).length }; }
}
