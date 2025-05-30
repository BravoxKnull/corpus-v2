const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://tlhzsssflsljvvzfyapc.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsaHpzc3NmbHNsanZ2emZ5YXBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg2MDYzOTYsImV4cCI6MjA2NDE4MjM5Nn0.-_Pp6zG2v7RiP_0m_pQOEJyAJPn5Zo4yPGCHHJH0IO0';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

// In-memory stores
const users = new Map();
const rooms = new Map();
let channelAutoId = 1;

// Helper: log with timestamp
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Helper: sanitize channel name
function sanitizeChannelName(name) {
  return String(name).replace(/[^\w\s\-]/g, '').trim().slice(0, 32);
}

// Helper: get public channel info
function getChannelsList() {
  return Object.entries(rooms).map(([id, ch]) => ({ id, name: id, userCount: ch.size }));
}

// Load channels from Supabase on server start
async function loadChannelsFromSupabase() {
  const { data, error } = await supabase.from('channels').select('*');
  if (data) {
    data.forEach(ch => {
      rooms.set(ch.id, new Set());
    });
    log(`Loaded ${data.length} channels from Supabase.`);
  } else if (error) {
    log('Error loading channels from Supabase: ' + error.message);
  }
}
loadChannelsFromSupabase();

io.on('connection', (socket) => {
  log(`Client connected: ${socket.id}`);

  // Send current channels list
  socket.emit('channels-list', getChannelsList());

  // Handle user registration
  socket.on('register-user', (userData) => {
    const { displayName, roomId } = userData;
    users.set(socket.id, { displayName, roomId });
    
    // Join room
    socket.join(roomId);
    
    // Get room participants
    const room = rooms.get(roomId) || new Set();
    room.add(socket.id);
    rooms.set(roomId, room);

    // Notify others in room
    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      displayName
    });

    // Send current participants to new user
    const participants = Array.from(room)
      .filter(id => id !== socket.id)
      .map(id => ({
        id,
        displayName: users.get(id)?.displayName
      }));

    socket.emit('participants', { users: participants });
  });

  // Handle WebRTC signaling
  socket.on('signal', (data) => {
    const { targetId, signal } = data;
    const targetSocket = io.sockets.sockets.get(targetId);
    
    if (targetSocket) {
      targetSocket.emit('signal', {
        signal,
        fromId: socket.id
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      const { roomId } = user;
      
      // Remove user from room
      const room = rooms.get(roomId);
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) {
          rooms.delete(roomId);
        }
      }

      // Notify others
      socket.to(roomId).emit('user-left', {
        id: socket.id
      });

      // Clean up user data
      users.delete(socket.id);
    }
    log(`Client disconnected: ${socket.id}`);
  });

  // Error handler
  socket.on('error', (err) => {
    log(`Socket error: ${err.message || err}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`Server running on port ${PORT}`));
