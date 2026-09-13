export class ThreeXuiClient {
  constructor({ baseUrl, username, password, inboundIds, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.username = username;
    this.password = password;
    this.inboundIds = inboundIds;
    this.fetchImpl = fetchImpl;
    this.cookie = "";
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("accept", "application/json");
    if (this.cookie) headers.set("cookie", this.cookie);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...options, headers, signal: AbortSignal.timeout(20_000) });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(",")[0].split(";")[0];
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok || (body && body.success === false)) throw new Error(body?.msg || `3x-ui request failed (${response.status})`);
    return body;
  }

  async login() {
    const body = new URLSearchParams({ username: this.username, password: this.password });
    await this.request("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  }

  async ensureLogin() {
    if (!this.cookie) await this.login();
  }

  async addClient({ email, subId, totalGB, expiryTime, limitIp, reset }) {
    await this.ensureLogin();
    const payload = { client: { email, subId, totalGB, expiryTime, limitIp, reset: resetDays(reset), enable: true }, inboundIds: this.inboundIds };
    try { return await this.request("/panel/api/clients/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); }
    catch (error) {
      this.cookie = "";
      await this.login();
      return this.request("/panel/api/clients/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    }
  }

  async getClient(email) { await this.ensureLogin(); return this.request(`/panel/api/clients/get/${encodeURIComponent(email)}`); }
  async updateClient(email, client) { await this.ensureLogin(); return this.request(`/panel/api/clients/update/${encodeURIComponent(email)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(client) }); }
  async deleteClient(email) { await this.ensureLogin(); return this.request(`/panel/api/clients/del/${encodeURIComponent(email)}`, { method: "POST" }); }
  async traffic(email) { await this.ensureLogin(); return this.request(`/panel/api/clients/traffic/${encodeURIComponent(email)}`); }
  async onlineClients() { await this.ensureLogin(); return this.request("/panel/api/clients/onlines", { method: "POST" }); }

  async getSubscriptionUrl(email, subId) {
    const response = await this.getClient(email);
    const links = response?.obj?.externalLinks || response?.externalLinks || [];
    const subscription = links.find((link) => link.kind === "subscription")?.value;
    if (subscription) return subscription;
    const direct = links.find((link) => link.kind === "link")?.value;
    if (direct) return direct;
    return `${this.baseUrl}/sub/${encodeURIComponent(subId)}`;
  }
}

export function resetDays(value) { return ({ never: 0, daily: 1, weekly: 7, monthly: 30 })[value] ?? 0; }
