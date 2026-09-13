function integer(value, fallback = 0) {
  const result = Number.parseInt(value, 10);
  return Number.isFinite(result) ? result : fallback;
}

export function loadConfig(environment = process.env) {
  const inboundIds = String(environment.THREEXUI_INBOUND_IDS || "").split(",").map((value) => integer(value.trim(), -1)).filter((value) => value > 0);
  return {
    port: integer(environment.PORT, 10000),
    publicBaseUrl: String(environment.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    databaseUrl: environment.DATABASE_URL || "",
    sessionSecret: environment.SESSION_SECRET || environment.DATABASE_URL || "local-development-secret",
    threeXui: {
      baseUrl: String(environment.THREEXUI_BASE_URL || "").replace(/\/$/, ""),
      username: environment.THREEXUI_USERNAME || "",
      password: environment.THREEXUI_PASSWORD || "",
      inboundIds
    },
    happ: {
      providerId: environment.HAPP_PROVIDER_ID || "euvlYGyS",
      authKey: environment.HAPP_AUTH_KEY || ""
    },
    legacyUpstreamUrl: environment.UPSTREAM_SUBSCRIPTION_URL || ""
  };
}

export function assertProductionConfig(config) {
  const missing = [];
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
}
