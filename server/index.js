const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, '../client')));

// In-memory user store
const users = {};

// Helper: log with timestamp
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Helper: sanitize name
function sanitizeName(name) {
  return String(name).replace(/[^\w\s\-]/g, '').trim().slice(0, 32);
}

io.on('connection', (socket) => {
  log(`Client connected: ${socket.id}`);

  socket.on('join-channel', ({ name }) => {
    try {
      const cleanName = sanitizeName(name) || 'Anonymous';
      // Prevent duplicate names
      if (Object.values(users).includes(cleanName)) {
        socket.emit('error', { message: 'Name already taken. Choose another.' });
        return;
      }
      users[socket.id] = cleanName;
      socket.broadcast.emit('user-joined', { id: socket.id, name: cleanName });
      socket.emit('all-users', { users });
      log(`User joined: ${cleanName} (${socket.id})`);
    } catch (err) {
      log(`Error in join-channel: ${err.message}`);
      socket.emit('error', { message: 'Failed to join channel.' });
    }
  });

  socket.on('signal', ({ targetId, signal }) => {
    try {
      if (!targetId || !signal) return;
      io.to(targetId).emit('signal', { id: socket.id, signal });
    } catch (err) {
      log(`Error in signal: ${err.message}`);
    }
  });

  socket.on('disconnect', () => {
    const name = users[socket.id];
    socket.broadcast.emit('user-left', socket.id);
    delete users[socket.id];
    log(`Client disconnected: ${socket.id} (${name})`);
  });

  // Handle custom errors
  socket.on('error', (err) => {
    log(`Socket error: ${err.message || err}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`Server running on port ${PORT}`));
