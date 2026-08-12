'use strict';

const { WebSocketServer } = require('ws');
const store = require('./store');

function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  function broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg);
    }
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', status: store.state.status, meta: store.state.meta }));
  });

  store.on('stage', (stage) => broadcast({ type: 'lifecycle', stage }));
  store.on('change', () => broadcast({ type: 'dataset_updated', meta: store.state.meta, at: store.state.lastRefreshAt }));
  store.on('error-state', (err) => broadcast({ type: 'error', message: err.message, details: err.details }));

  return wss;
}

module.exports = { attachWebSocketServer };
