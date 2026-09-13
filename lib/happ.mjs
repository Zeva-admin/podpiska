import { createHash } from "node:crypto";

const API_BASE = "https://api.happ-proxy.com";

export class HappClient {
  constructor({ providerId, authKey, fetchImpl = globalThis.fetch }) { this.providerId = providerId; this.authKey = authKey; this.fetchImpl = fetchImpl; }
  async call(path, params = {}) {
    if (!this.authKey) throw new Error("HAPP_AUTH_KEY is not configured.");
    const query = new URLSearchParams({ provider_code: this.providerId, auth_key: this.authKey, ...Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")) });
    const response = await this.fetchImpl(`${API_BASE}${path}?${query}`, { signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.rc === 0) throw new Error(body.msg || `Happ API failed (${response.status})`);
    return body;
  }
  async createInstallLink(installLimit, note) { return this.call("/api/add-install", { install_limit: installLimit, note }); }
  async updateInstall(id, values) { return this.call("/api/update-install", { id, ...values }); }
  async listHwid(installCode) { return this.call("/api/list-hwid", { install_code: installCode }); }
  async deleteHwid(installCode, hwid) { return this.call("/api/delete-hwid", { install_code: installCode, hwid }); }
  async addDomain(domainHash, domainName) { return this.call("/api/add-domain", { domain_hash: domainHash, domain_name: domainName }); }
  async listDomains() { return this.call("/api/list-domain"); }
}

export function subscriptionUserinfo({ upload = 0, download = 0, total = 0, expiresAt = null }) {
  const expire = expiresAt ? Math.floor(new Date(expiresAt).getTime() / 1000) : 0;
  return `upload=${Math.max(0, Number(upload) || 0)}; download=${Math.max(0, Number(download) || 0)}; total=${Math.max(0, Number(total) || 0)}; expire=${expire}`;
}

export function encodeAnnouncement(text) { return `base64:${Buffer.from(String(text || ""), "utf8").toString("base64")}`; }
export function hashDomain(host) { return createHash("sha256").update(String(host).trim().toLowerCase(), "utf8").digest("hex"); }
