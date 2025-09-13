// server.js
import express from "express";
import cors from "cors";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Configurações da PocketOption - use suas credenciais reais
const POCKET_EMAIL = process.env.POCKET_EMAIL || "seu-email@example.com";
const POCKET_PASSWORD = process.env.POCKET_PASSWORD || "sua-senha";
const POCKET_SSID = process.env.POCKET_SSID || null; // Opcional

const POCKET_WS_URL = "wss://api.pocketoption.com:8085/socket.io/?EIO=3&transport=websocket";

let pocketWS;
let isLoggedIn = false;
let candlesCache = {};
let assetPrices = {};

// Ativos principais para monitorar
const MAIN_ASSETS = [
  "EURUSD_otc", "GBPUSD_otc", "USDJPY_otc", "AUDUSD_otc", 
  "USDCAD_otc", "BTCUSD_otc", "ETHUSD_otc"
];

// Criar servidor HTTP + WS interno
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let clientes = [];

// ====== FUNÇÕES DE UTILIDADE ======
function broadcast(msg) {
  clientes.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });
}

function formatSocketMessage(type, data) {
  return `42["${type}",${JSON.stringify(data)}]`;
}

// ====== CONEXÃO COM POCKETOPTION ======
function conectarPocketOption() {
  console.log("🔌 Conectando à PocketOption...");
  
  pocketWS = new WebSocket(POCKET_WS_URL);

  pocketWS.on("open", () => {
    console.log("✅ WebSocket PocketOption conectado");
    
    // Fazer login automático
    if (POCKET_SSID) {
      console.log("🔑 Fazendo login com SSID...");
      pocketWS.send(formatSocketMessage("login", {
        ssid: POCKET_SSID
      }));
    } else if (POCKET_EMAIL && POCKET_PASSWORD) {
      console.log("🔑 Fazendo login com email/senha...");
      pocketWS.send(formatSocketMessage("login", {
        email: POCKET_EMAIL,
        password: POCKET_PASSWORD
      }));
    }
    
    // Solicitar lista de ativos disponíveis
    setTimeout(() => {
      pocketWS.send('42["assets_status"]');
    }, 2000);
  });

  pocketWS.on("message", (msg) => {
    const raw = msg.toString();
    
    // Ignorar mensagens de controle
    if (!raw.startsWith("42")) return;
    
    let data;
    try {
      data = JSON.parse(raw.slice(2));
    } catch (e) {
      return;
    }

    const eventType = data[0];
    const payload = data[1];

    switch (eventType) {
      case "login":
        if (payload.success) {
          console.log("✅ Login realizado com sucesso!");
          isLoggedIn = true;
          
          // Solicitar lista de ativos após login
          setTimeout(() => {
            pocketWS.send('42["assets_status"]');
          }, 1000);
        } else {
          console.error("❌ Falha no login:", payload.message);
        }
        break;

      case "assets_status":
        console.log("📋 Lista de ativos recebida");
        processarAtivos(payload);
        break;

      case "candles":
        if (Array.isArray(payload) && payload.length > 0) {
          const asset = payload[0]?.asset;
          if (asset) {
            candlesCache[asset] = payload;
            
            // Atualizar preço atual
            const latestCandle = payload[payload.length - 1];
            if (latestCandle) {
              assetPrices[asset] = latestCandle.close || latestCandle.c;
            }
            
            console.log(`📊 Candles de ${asset} atualizados (preço: ${assetPrices[asset]})`);
            
            // Broadcast para clientes conectados
            broadcast({
              type: "candles",
              asset,
              data: payload,
              price: assetPrices[asset]
            });
          }
        }
        break;

      case "tick":
        if (payload.asset && payload.value) {
          assetPrices[payload.asset] = payload.value;
          
          // Broadcast tick em tempo real
          broadcast({
            type: "tick",
            asset: payload.asset,
            price: payload.value,
            timestamp: Date.now()
          });
        }
        break;

      default:
        // Log outros eventos para debug
        if (eventType !== "pong") {
          console.log(`📨 Evento: ${eventType}`, payload);
        }
    }
  });

  pocketWS.on("close", (code, reason) => {
    console.log(`⚠️ PocketOption desconectada (código: ${code}). Reconectando...`);
    isLoggedIn = false;
    
    // Reconectar após 5 segundos
    setTimeout(conectarPocketOption, 5000);
  });

  pocketWS.on("error", (err) => {
    console.error("❌ Erro no WebSocket PocketOption:", err.message);
  });

  // Ping periódico para manter conexão
  setInterval(() => {
    if (pocketWS && pocketWS.readyState === WebSocket.OPEN) {
      pocketWS.send('2'); // Ping
    }
  }, 25000);
}

// ====== PROCESSAR ATIVOS E ASSINAR PRINCIPAIS ======
function processarAtivos(listaAtivos) {
  if (!Array.isArray(listaAtivos)) return;
  
  console.log(`📊 Processando ${listaAtivos.length} ativos...`);
  
  // Filtrar ativos principais
  const ativosDisponiveis = listaAtivos.filter(asset => 
    MAIN_ASSETS.includes(asset.symbol) && asset.enabled
  );
  
  console.log("✅ Ativos principais disponíveis:", ativosDisponiveis.map(a => a.symbol));
  
  // Assinar candles de cada ativo principal
  ativosDisponiveis.forEach(asset => {
    setTimeout(() => {
      console.log(`📈 Assinando candles de ${asset.symbol}`);
      
      // Solicitar candles históricos
      pocketWS.send(formatSocketMessage("candles", {
        asset: asset.symbol,
        tf: 60, // 1 minuto
        cnt: 50 // 50 velas
      }));
      
      // Assinar ticks em tempo real
      pocketWS.send(formatSocketMessage("subscribe", {
        asset: asset.symbol
      }));
      
    }, Math.random() * 2000); // Espaçar requisições
  });
}

// ====== ROTAS HTTP ======
app.get("/", (req, res) => {
  res.json({ 
    status: "API PocketOption rodando ✅",
    connected: isLoggedIn,
    assets: Object.keys(candlesCache).length,
    prices: Object.keys(assetPrices).length
  });
});

app.get("/candles", (req, res) => {
  res.json(candlesCache);
});

app.get("/prices", (req, res) => {
  res.json(assetPrices);
});

app.get("/status", (req, res) => {
  res.json({
    server: "online",
    pocketoption_connected: isLoggedIn,
    websocket_clients: clientes.length,
    monitored_assets: MAIN_ASSETS,
    available_data: Object.keys(candlesCache)
  });
});

// ====== WEBSOCKET INTERNO ======
wss.on("connection", (ws) => {
  console.log("🔌 Cliente conectado ao WebSocket");
  clientes.push(ws);

  // Enviar dados atuais imediatamente
  ws.send(JSON.stringify({
    type: "snapshot",
    candles: candlesCache,
    prices: assetPrices,
    connected: isLoggedIn
  }));

  ws.on("close", () => {
    clientes = clientes.filter(c => c !== ws);
    console.log("❌ Cliente WebSocket desconectado");
  });

  ws.on("error", (err) => {
    console.log("⚠️ Erro no cliente WebSocket:", err.message);
  });
});

// ====== ATUALIZAÇÃO PERIÓDICA ======
setInterval(() => {
  if (pocketWS && pocketWS.readyState === WebSocket.OPEN && isLoggedIn) {
    // Solicitar atualização da lista de ativos
    pocketWS.send('42["assets_status"]');
  }
}, 60000); // A cada 1 minuto

// ====== INICIALIZAÇÃO ======
server.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`);
  console.log(`📧 Email configurado: ${POCKET_EMAIL ? '✅' : '❌'}`);
  console.log(`🔑 SSID configurado: ${POCKET_SSID ? '✅' : '❌'}`);
  
  // Conectar à PocketOption
  conectarPocketOption();
});

// ====== TRATAMENTO DE ERROS ======
process.on('uncaughtException', (err) => {
  console.error('❌ Erro não capturado:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rejeitada:', err);
});