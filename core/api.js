// core/api.js
const WORKER_URL = "https://notion-proxy.churan756.workers.dev";

async function _fetch(action, options = {}) {
  const url = new URL(WORKER_URL);
  url.searchParams.set("action", action);

  if (options.params) {
    Object.entries(options.params).forEach(([k, v]) =>
      url.searchParams.set(k, v)
    );
  }

  const res = await fetch(url.toString(), {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "API error");
  }

  return data;
}

export const API = {

  // Prices
  async prices() {
    return _fetch("prices");
  },

  // FRED
  async fred(series) {
    return _fetch("fred", {
      params: { series }
    });
  },

  // AI
  async ai(prompt) {
    return _fetch("ai", {
      method: "POST",
      body: { prompt }
    });
  },

  // Notion
  async query(db, token) {
    return _fetch("query", {
      method: "POST",
      params: { db },
      headers: {
        "X-Notion-Token": token
      }
    });
  },

  async create(body, token) {
    return _fetch("create", {
      method: "POST",
      headers: {
        "X-Notion-Token": token
      },
      body
    });
  },

  async update(id, body, token) {
    return _fetch("update", {
      method: "PATCH",
      params: { id },
      headers: {
        "X-Notion-Token": token
      },
      body
    });
  },

  async remove(id, token) {
    return _fetch("delete", {
      method: "PATCH",
      params: { id },
      headers: {
        "X-Notion-Token": token
      }
    });
  }

};
