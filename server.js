const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// Fecha diaria en Argentina para resetear contador
function todayISO_AR() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const yyyy = parts.find(p => p.type === "year").value;
  const mm = parts.find(p => p.type === "month").value;
  const dd = parts.find(p => p.type === "day").value;
  return `${yyyy}-${mm}-${dd}`;
}

function newId() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}
function normalizeName(s) {
  return (s ?? "").trim().replace(/\s+/g, " ");
}

let state = freshState();
function freshState() {
  return {
    queue: [], // [{ id, name, createdAt }]
    stats: { atendidosHoy: 0, ultimoAtendido: "—", diaISO: todayISO_AR() },
    lastAction: null, // { type, by, ts }
  };
}

function ensureDailyReset() {
  const t = todayISO_AR();
  if (state.stats.diaISO !== t) {
    state.stats = { atendidosHoy: 0, ultimoAtendido: state.stats.ultimoAtendido ?? "—", diaISO: t };
  }
}

function broadcast() {
  ensureDailyReset();
  const msg = JSON.stringify({ type: "STATE", payload: state });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function setLastAction(type, by) {
  state.lastAction = { type, by: String(by || ""), ts: Date.now() };
}

wss.on("connection", (ws) => {
  ensureDailyReset();
  ws.send(JSON.stringify({ type: "STATE", payload: state }));

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    ensureDailyReset();

    const type = data?.type;
    const payload = data?.payload || {};
    const clientId = payload?.clientId || "";

    if (type === "ENQUEUE") {
      const name = normalizeName(payload?.name);
      if (!name) return;
      state.queue.push({ id: newId(), name, createdAt: new Date().toISOString() });
      setLastAction("ENQUEUE", clientId);
      return broadcast();
    }

    if (type === "BULK_ADD") {
      const names = Array.isArray(payload?.names) ? payload.names : [];
      const cleaned = names.map(normalizeName).filter(Boolean);
      if (!cleaned.length) return;
      for (const n of cleaned) {
        state.queue.push({ id: newId(), name: n, createdAt: new Date().toISOString() });
      }
      setLastAction("BULK_ADD", clientId);
      return broadcast();
    }

    if (type === "DEQUEUE") {
      if (!state.queue.length) return;
      const it = state.queue.shift();
      state.stats.atendidosHoy += 1;
      state.stats.ultimoAtendido = it.name;
      setLastAction("DEQUEUE", clientId);
      return broadcast();
    }

    if (type === "PEEK") {
      // No cambia estado: ignoramos o podrías responder al que lo pidió
      return;
    }

    if (type === "CLEAR_QUEUE") {
      state.queue = [];
      setLastAction("CLEAR_QUEUE", clientId);
      return broadcast();
    }

    if (type === "RESET_ALL") {
      state = freshState();
      setLastAction("RESET_ALL", clientId);
      return broadcast();
    }

    if (type === "MOVE") {
      const id = String(payload?.id || "");
      const dir = Number(payload?.dir);
      const i = state.queue.findIndex(x => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= state.queue.length) return;
      const tmp = state.queue[i];
      state.queue[i] = state.queue[j];
      state.queue[j] = tmp;
      setLastAction("MOVE", clientId);
      return broadcast();
    }

    if (type === "EDIT") {
      const id = String(payload?.id || "");
      const name = normalizeName(payload?.name);
      if (!name) return;
      const i = state.queue.findIndex(x => x.id === id);
      if (i < 0) return;
      state.queue[i].name = name;
      setLastAction("EDIT", clientId);
      return broadcast();
    }

    if (type === "DELETE") {
      const id = String(payload?.id || "");
      const i = state.queue.findIndex(x => x.id === id);
      if (i < 0) return;
      state.queue.splice(i, 1);
      setLastAction("DELETE", clientId);
      return broadcast();
    }

    if (type === "IMPORT_STATE") {
      // Importa reemplazando (cola + stats opcional)
      try {
        const parsed = payload?.data;
        if (!parsed || !Array.isArray(parsed.queue)) return;

        const q = parsed.queue
          .map(x => ({
            id: String(x.id || newId()),
            name: normalizeName(x.name),
            createdAt: x.createdAt || new Date().toISOString(),
          }))
          .filter(x => x.name);

        const t = todayISO_AR();
        const stats = parsed.stats && typeof parsed.stats === "object" ? parsed.stats : {};

        state.queue = q;
        state.stats = {
          atendidosHoy: (stats.diaISO === t && Number.isFinite(stats.atendidosHoy)) ? stats.atendidosHoy : 0,
          ultimoAtendido: normalizeName(stats.ultimoAtendido) || "—",
          diaISO: t,
        };
        setLastAction("IMPORT_STATE", clientId);
        return broadcast();
      } catch {
        return;
      }
    }
  });
});

const PORT = 8081;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Turnero backend+frontend en http://0.0.0.0:${PORT}`);
});

