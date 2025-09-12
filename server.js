// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const POCKET_WS_URL = process.env.POCKET_WS_URL ||
  "wss://api.pocketoption.com:8085/socket.io/?EIO=3&transport=websocket";

let SESSION_ID = process.env.SSID || null; // pode vir do .env ou do /config
let pocketWS = null;
let ativosSelecionados = [];
let candlesCache = {};
let clientes = [];
let saldoAtual = null;

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function conectarPocketOption() {
  try {
    if (pocketWS && (pocketWS.readyState === WebSocket.OPEN || pocketWS.readyState === WebSocket.CONNECTING)) {
      pocketWS.terminate();
    }
  } catch (e) {
    console.warn("Erro ao terminar conexão anterior:", e.message);
  }

  const options = {};
  if (SESSION_ID) {
    options.headers = { Cookie: `ssid=${SESSION_ID}` };
    console.log("🔑 Conectando com SSID vindo de variável/config...");
  } else {
    console.log("⚠️ Conectando sem SSID (apenas dados públicos)...");
  }

  pocketWS = new WebSocket(POCKET_WS_URL, options);

  pocketWS.on("open", () => {
    console.log("📡 Conectado à Pocket Option WebSocket");
    pocketWS.send('42["assets_status"]');
    if (SESSION_ID) {
      pocketWS.send('42["balance_get"]');
    }
  });

  pocketWS.on("message", (msg) => {
    const raw = msg.toString();
    if (!raw.startsWith("42")) return;
    let data;
    try { data = JSON.parse(raw.slice(2)); } catch { return; }

    if (data[0] === "assets_status") selecionarAtivos(data[1]);
    if (data[0] === "candles") {
      const asset = data[1][0]?.asset;
      if (asset) {
        candlesCache[asset] = data[1];
        broadcast({ type: "candles", asset, data: data[1] });
      }
    }
    if (["balance_get","balance","balance_update"].includes(data[0])) {
      saldoAtual = data[1];
      broadcast({ type: "balance", data: saldoAtual });
    }
  });

  pocketWS.on("close", () => {
    console.warn("⚠️ Conexão fechada. Tentando reconectar em 5s...");
    setTimeout(conectarPocketOption, 5000);
  });

  pocketWS.on("error", (err) => {
    console.error("❌ Erro WebSocket PocketOption:", err.message || err);
  });
}

function selecionarAtivos(lista) {
  if (!Array.isArray(lista)) return;
  const otc = lista.filter((a) => a.symbol && a.symbol.includes("_otc")).slice(0, 10);
  const abertos = lista.filter((a) => a.symbol && !a.symbol.includes("_otc") && a.payoff >= 0.85).slice(0, 5);
  ativosSelecionados = [...otc, ...abertos];
  ativosSelecionados.forEach((asset) => {
    if (pocketWS && pocketWS.readyState === WebSocket.OPEN) {
      pocketWS.send(`42["candles",{"asset":"${asset.symbol}","tf":60,"cnt":10}]`);
    }
  });
}

function broadcast(msg) {
  clientes.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });
}

app.get("/", (req, res) => {
  res.json({ status: "API PocketOption rodando ✅", ssidConfigured: !!SESSION_ID });
});

app.get("/candles", (req, res) => res.json(candlesCache));

app.get("/saldo", (req, res) => {
  if (!saldoAtual) return res.status(404).json({ error: "Saldo não disponível" });
  res.json(saldoAtual);
});

app.post("/config", (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: "SSID não fornecido" });
  SESSION_ID = ssid;
  console.log("🔑 SSID atualizado via /config");
  setTimeout(() => conectarPocketOption(), 1000);
  res.json({ status: "SSID recebido. Reconectando..." });
});

wss.on("connection", (ws) => {
  clientes.push(ws);
  ws.send(JSON.stringify({ type: "snapshot", data: { candles: candlesCache, balance: saldoAtual } }));
  ws.on("close", () => { clientes = clientes.filter((c) => c !== ws); });
  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.type === "get_candles" && parsed.asset) {
        ws.send(JSON.stringify({ type: "candles", asset: parsed.asset, data: candlesCache[parsed.asset] || null }));
      }
    } catch {}
  });
});

setInterval(() => {
  if (pocketWS && pocketWS.readyState === WebSocket.OPEN) {
    pocketWS.send('42["assets_status"]');
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  conectarPocketOption();
});
