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
const channels = new Map();

// Helper: generate unique ID
function generateId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// Helper: log with timestamp
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Helper: sanitize channel name
function sanitizeChannelName(name) {
  return String(name).replace(/[^\w\s\-]/g, '').trim().slice(0, 32);
}

// Load channels from Supabase on server start
async function loadChannelsFromSupabase() {
  const { data, error } = await supabase.from('channels').select('*');
  if (data) {
    data.forEach(ch => {
      channels.set(ch.id, {
        id: ch.id,
        name: ch.name,
        users: new Set([ch.id]),
        userCount: 1,
        createdAt: ch.created_at
      });
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
  socket.emit('channels-list', Array.from(channels.values()));

  // Handle user registration
  socket.on('register-user', (userData) => {
    const { id, username, displayName } = userData;
    if (!displayName) {
        console.error('No display name provided for user:', id);
        return;
    }
    users.set(socket.id, { id, username, displayName });
    console.log(`User registered: ${displayName} (${socket.id})`);
  });

  // Handle channel creation
  socket.on('create-channel', ({ name }) => {
    try {
      if (!name || typeof name !== 'string') {
        throw new Error('Invalid channel name');
      }

      const sanitizedName = sanitizeChannelName(name);
      if (!sanitizedName) {
        throw new Error('Channel name cannot be empty');
      }

      // Check if channel name already exists
      for (const channel of channels.values()) {
        if (channel.name.toLowerCase() === sanitizedName.toLowerCase()) {
          throw new Error('Channel name already exists');
        }
      }

      const channelId = generateId();
      const channel = {
        id: channelId,
        name: sanitizedName,
        users: new Set([socket.id]),
        userCount: 1,
        createdAt: new Date().toISOString()
      };

      channels.set(channelId, channel);
      socket.join(channelId);
      socket.currentChannel = channelId;

      log(`Channel created: ${sanitizedName} (${channelId})`);
      
      // Notify client of success
      socket.emit('channel-created', {
        id: channelId,
        name: sanitizedName,
        userCount: 1
      });

      // Broadcast updated channel list to all clients
      broadcastChannelList();
    } catch (error) {
      log(`Channel creation error: ${error.message}`);
      socket.emit('channel-error', { message: error.message });
    }
  });

  // Handle joining channel
  socket.on('join-channel', ({ channelId }) => {
    try {
      console.log(`User ${socket.id} attempting to join channel ${channelId}`);
      
      const channel = channels.get(channelId);
      if (!channel) {
        throw new Error('Channel not found');
      }

      // Leave current channel if any
      if (socket.currentChannel) {
        const currentChannel = channels.get(socket.currentChannel);
        if (currentChannel) {
          currentChannel.users.delete(socket.id);
          currentChannel.userCount--;
          socket.leave(socket.currentChannel);
          
          // Notify others in the old channel
          socket.to(socket.currentChannel).emit('user-left', {
            socketId: socket.id
          });
          
          // Remove channel if empty
          if (currentChannel.userCount === 0) {
            channels.delete(socket.currentChannel);
          }
        }
      }

      // Join new channel
      channel.users.add(socket.id);
      channel.userCount++;
      socket.join(channelId);
      socket.currentChannel = channelId;

      // Get user info
      const user = users.get(socket.id);
      if (!user || !user.displayName) {
        console.error('User not properly registered:', socket.id);
        throw new Error('User not properly registered');
      }

      // Notify others in channel
      socket.to(channelId).emit('user-joined', {
        socketId: socket.id,
        displayName: user.displayName
      });

      // Send current participants to new user
      const participants = Array.from(channel.users)
        .filter(id => id !== socket.id)
        .map(id => {
          const participant = users.get(id);
          return {
            socketId: id,
            displayName: participant ? participant.displayName : 'Unknown User'
          };
        });

      socket.emit('participants', { participants });
      
      // Broadcast updated channel list
      broadcastChannelList();

      console.log(`User ${user.displayName} (${socket.id}) joined channel ${channelId}`);
    } catch (error) {
      console.error(`Channel join error for ${socket.id}:`, error);
      socket.emit('channel-error', { message: error.message });
    }
  });

  // Handle leaving channel
  socket.on('leave-channel', () => {
    if (socket.currentChannel) {
      const channel = channels.get(socket.currentChannel);
      if (channel) {
        channel.users.delete(socket.id);
        channel.userCount--;
        socket.leave(socket.currentChannel);
        
        // Remove channel if empty
        if (channel.userCount === 0) {
          channels.delete(socket.currentChannel);
        }
        
        socket.currentChannel = null;
        broadcastChannelList();
      }
    }
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
      // Remove user from current channel
      if (socket.currentChannel) {
        const channel = channels.get(socket.currentChannel);
        if (channel) {
          channel.users.delete(socket.id);
          channel.userCount--;
          
          // Remove channel if empty
          if (channel.userCount === 0) {
            channels.delete(socket.currentChannel);
          }
          
          // Notify others
          socket.to(socket.currentChannel).emit('user-left', {
            socketId: socket.id
          });
        }
      }

      // Clean up user data
      users.delete(socket.id);
      broadcastChannelList();
    }
    log(`Client disconnected: ${socket.id}`);
  });

  // Error handler
  socket.on('error', (err) => {
    log(`Socket error: ${err.message || err}`);
  });
});

// Helper function to broadcast channel list
function broadcastChannelList() {
  const channelList = Array.from(channels.values()).map(channel => ({
    id: channel.id,
    name: channel.name,
    userCount: channel.userCount
  }));
  io.emit('channels-list', channelList);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`Server running on port ${PORT}`));
