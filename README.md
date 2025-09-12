# API-20-PocketOption

API backend para conectar com a corretora PocketOption via WebSocket e integrar com aplicativos (ex: QuantumSignals).

## Instalação

```bash
npm install
```

## Execução local

1. Copie `.env.example` para `.env` e preencha os valores (principalmente `SSID`).
2. Rode o servidor:

```bash
npm start
```

3. Endpoints disponíveis:
- `GET /` → status
- `GET /candles` → últimos candles
- `GET /saldo` → saldo da conta (se SSID válido)
- `POST /config` → atualizar SSID em runtime

## Deploy no Render

- Configure as variáveis de ambiente no painel do Render (não suba `.env`).
- As variáveis necessárias: `SSID`, `POCKET_WS_URL` (opcional), `PORT`.
