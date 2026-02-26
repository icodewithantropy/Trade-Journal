// core/api.js
// Clean Worker-Only API Layer

const WORKER_URL = "https://notion-proxy.churan756.workers.dev";

// ─────────────────────────────────────────────
// Internal Fetch Helper
// ─────────────────────────────────────────────

async function _fetch(action, options = {}) {

  const url = new URL(WORKER_URL);
  url.searchParams.set("action", action);

  // Add query params
  if (options.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "API request failed");
  }

  return data;
}

// ─────────────────────────────────────────────
// Public API Object
// ─────────────────────────────────────────────

const API = {

  // ───── Prices (TwelveData via Worker) ─────
  async prices() {
    return _fetch("prices");
  },

  // ───── FRED Macro Data ─────
  async fred(seriesId) {
    return _fetch("fred", {
      params: { series: seriesId }
    });
  },

  // ───── AI (Mistral via Worker) ─────
  async ai(prompt) {
    return _fetch("ai", {
      method: "POST",
      body: { prompt }
    });
  },

  // ───── Notion Query ─────
  async query(dbId, token) {
    return _fetch("query", {
      method: "POST",
      params: { db: dbId },
      headers: {
        "X-Notion-Token": token
      }
    });
  },

  // ───── Notion Create ─────
  async create(body, token) {
    return _fetch("create", {
      method: "POST",
      headers: {
        "X-Notion-Token": token
      },
      body
    });
  },

  // ───── Notion Update ─────
  async update(pageId, body, token) {
    return _fetch("update", {
      method: "PATCH",
      params: { id: pageId },
      headers: {
        "X-Notion-Token": token
      },
      body
    });
  },

  // ───── Notion Delete (Archive) ─────
  async remove(pageId, token) {
    return _fetch("delete", {
      method: "PATCH",
      params: { id: pageId },
      headers: {
        "X-Notion-Token": token
      }
    });
  }

};

// Make globally accessible (important)
window.API = API;
