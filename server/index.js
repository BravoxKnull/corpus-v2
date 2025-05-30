const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../client')));

const users = {};

io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('join-channel', ({ name }) => {
    users[socket.id] = name;
    socket.broadcast.emit('user-joined', { id: socket.id, name });
    socket.emit('all-users', { users });
  });

  socket.on('signal', ({ targetId, signal }) => {
    io.to(targetId).emit('signal', { id: socket.id, signal });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit('user-left', socket.id);
    delete users[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
