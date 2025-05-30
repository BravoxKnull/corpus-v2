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
const users = {}; // { socketId: { id, username, displayName, channelId } }
const channels = {}; // { channelId: { name, users: Set<socketId> } }
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
  return Object.entries(channels).map(([id, ch]) => ({ id, name: ch.name, userCount: ch.users.size }));
}

// Load channels from Supabase on server start
async function loadChannelsFromSupabase() {
  const { data, error } = await supabase.from('channels').select('*');
  if (data) {
    data.forEach(ch => {
      channels[ch.id] = { name: ch.name, users: new Set() };
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

  // Handle user registration (from client after auth)
  socket.on('register-user', ({ id, username, displayName }) => {
    users[socket.id] = { id, username, displayName, channelId: null };
    log(`User registered: ${username} (${socket.id})`);
    socket.emit('channels-list', getChannelsList());
  });

  // Create a new channel (persist in Supabase)
  socket.on('create-channel', async ({ name }) => {
    const cleanName = sanitizeChannelName(name);
    if (!cleanName) {
      socket.emit('error', { message: 'Invalid channel name.' });
      return;
    }
    if (Object.values(channels).some(ch => ch.name === cleanName)) {
      socket.emit('error', { message: 'Channel name already exists.' });
      return;
    }
    // Insert into Supabase
    const { data, error } = await supabase.from('channels').insert([{ name: cleanName }]).select().single();
    if (error) {
      socket.emit('error', { message: 'Failed to create channel.' });
      log('Supabase error: ' + error.message);
      return;
    }
    channels[data.id] = { name: data.name, users: new Set() };
    io.emit('channels-list', getChannelsList());
    log(`Channel created: ${cleanName} (${data.id})`);
  });

  // Join a channel
  socket.on('join-channel', ({ channelId }) => {
    const user = users[socket.id];
    if (!user) return;
    // Leave previous channel
    if (user.channelId && channels[user.channelId]) {
      channels[user.channelId].users.delete(socket.id);
      io.to(user.channelId).emit('user-left', { socketId: socket.id });
      socket.leave(user.channelId);
    }
    // Join new channel
    if (!channels[channelId]) {
      socket.emit('error', { message: 'Channel does not exist.' });
      return;
    }
    user.channelId = channelId;
    channels[channelId].users.add(socket.id);
    socket.join(channelId);
    // Notify users in channel
    io.to(channelId).emit('user-joined', { socketId: socket.id, username: user.username, displayName: user.displayName });
    // Send current participants
    const participants = Array.from(channels[channelId].users).map(sid => {
      const u = users[sid];
      return u ? { socketId: sid, username: u.username, displayName: u.displayName } : null;
    }).filter(Boolean);
    socket.emit('participants', { participants });
    log(`User ${user.username} joined channel ${channels[channelId].name}`);
  });

  // Leave channel
  socket.on('leave-channel', () => {
    const user = users[socket.id];
    if (user && user.channelId && channels[user.channelId]) {
      channels[user.channelId].users.delete(socket.id);
      io.to(user.channelId).emit('user-left', { socketId: socket.id });
      socket.leave(user.channelId);
      user.channelId = null;
      log(`User ${user.username} left channel`);
    }
  });

  // WebRTC signaling (per channel)
  socket.on('signal', ({ targetId, signal }) => {
    const user = users[socket.id];
    if (!user || !user.channelId) return;
    if (!channels[user.channelId] || !channels[user.channelId].users.has(targetId)) return;
    io.to(targetId).emit('signal', { id: socket.id, signal });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      if (user.channelId && channels[user.channelId]) {
        channels[user.channelId].users.delete(socket.id);
        io.to(user.channelId).emit('user-left', { socketId: socket.id });
      }
      delete users[socket.id];
      log(`Client disconnected: ${socket.id}`);
    }
  });

  // Error handler
  socket.on('error', (err) => {
    log(`Socket error: ${err.message || err}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`Server running on port ${PORT}`));
