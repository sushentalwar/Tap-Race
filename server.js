const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory game store
// game = { state, players (Map), creator, timer, timeLeft }
const games = new Map();
const socketToGame = new Map(); // socketId -> gameId

const GAME_DURATION = 15;

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

function serializeGame(gameId, game, forSocketId) {
  const players = [];
  for (const [sid, p] of game.players) {
    players.push({ id: sid, name: p.name, ready: p.ready, taps: p.taps });
  }
  return {
    gameId,
    state: game.state,
    players,
    timeLeft: game.timeLeft,
    isCreator: forSocketId === game.creator
  };
}

function broadcastGameState(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  for (const sid of game.players.keys()) {
    io.to(sid).emit('game_state', serializeGame(gameId, game, sid));
  }
}

function broadcastTapUpdate(gameId, playerId, taps) {
  const game = games.get(gameId);
  if (!game) return;
  for (const sid of game.players.keys()) {
    io.to(sid).emit('tap_update', { playerId, taps });
  }
}

function startGame(gameId) {
  const game = games.get(gameId);
  if (!game) return;

  game.state = 'playing';
  game.timeLeft = GAME_DURATION;
  for (const p of game.players.values()) p.taps = 0;

  broadcastGameState(gameId);

  game.timer = setInterval(() => {
    game.timeLeft--;
    if (game.timeLeft <= 0) {
      clearInterval(game.timer);
      game.timer = null;
      game.state = 'finished';
    }
    broadcastGameState(gameId);
  }, 1000);
}

function removeSocketFromGame(socketId) {
  const gameId = socketToGame.get(socketId);
  if (!gameId) return;
  socketToGame.delete(socketId);

  const game = games.get(gameId);
  if (!game) return;
  game.players.delete(socketId);

  if (game.players.size === 0) {
    if (game.timer) clearInterval(game.timer);
    games.delete(gameId);
    return;
  }

  // Reassign creator if needed
  if (game.creator === socketId) {
    game.creator = game.players.keys().next().value;
  }

  broadcastGameState(gameId);
}

io.on('connection', (socket) => {

  socket.on('create_game', ({ name }) => {
    removeSocketFromGame(socket.id);

    const gameId = generateId();
    const game = {
      state: 'waiting',
      players: new Map([[socket.id, { name, ready: false, taps: 0 }]]),
      creator: socket.id,
      timer: null,
      timeLeft: GAME_DURATION
    };

    games.set(gameId, game);
    socketToGame.set(socket.id, gameId);
    socket.emit('game_state', serializeGame(gameId, game, socket.id));
  });

  socket.on('join_game', ({ gameId, name }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error', { message: 'Game not found. The link may have expired.' });
      return;
    }
    if (game.state !== 'waiting') {
      socket.emit('error', { message: 'This game has already started.' });
      return;
    }

    removeSocketFromGame(socket.id);
    game.players.set(socket.id, { name, ready: false, taps: 0 });
    socketToGame.set(socket.id, gameId);
    broadcastGameState(gameId);
  });

  socket.on('set_ready', () => {
    const gameId = socketToGame.get(socket.id);
    if (!gameId) return;
    const game = games.get(gameId);
    if (!game || game.state !== 'waiting') return;

    const player = game.players.get(socket.id);
    player.ready = !player.ready;

    const allReady = [...game.players.values()].every(p => p.ready);
    if (allReady && game.players.size >= 1) {
      startGame(gameId);
    } else {
      broadcastGameState(gameId);
    }
  });

  socket.on('tap', () => {
    const gameId = socketToGame.get(socket.id);
    if (!gameId) return;
    const game = games.get(gameId);
    if (!game || game.state !== 'playing') return;

    const player = game.players.get(socket.id);
    if (player) {
      player.taps++;
      broadcastTapUpdate(gameId, socket.id, player.taps);
    }
  });

  socket.on('go_again', () => {
    const gameId = socketToGame.get(socket.id);
    if (!gameId) return;
    const game = games.get(gameId);
    if (!game || socket.id !== game.creator) return;

    game.state = 'waiting';
    game.timeLeft = GAME_DURATION;
    for (const p of game.players.values()) {
      p.ready = false;
      p.taps = 0;
    }
    broadcastGameState(gameId);
  });

  socket.on('disconnect', () => {
    removeSocketFromGame(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Tap Race running on http://localhost:${PORT}`);
});
