// Tiny client for the local HTTP API, with the per-session auth token that
// the app passes in the URL.

const params = new URLSearchParams(location.search);
export const TOKEN = params.get("t") || sessionStorage.getItem("collector-token") || "";
if (TOKEN) sessionStorage.setItem("collector-token", TOKEN);

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Collector-Token": TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    throw new ApiError(data?.error || res.statusText || "request failed", res.status, data?.code);
  }
  return data;
}

export function fileUrl(rel) {
  return `/files?path=${encodeURIComponent(rel)}&t=${encodeURIComponent(TOKEN)}`;
}
