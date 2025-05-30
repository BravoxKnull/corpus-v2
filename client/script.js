// --- Supabase Auth & User Info ---
const SUPABASE_URL = 'https://tlhzsssflsljvvzfyapc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsaHpzc3NmbHNsanZ2emZ5YXBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg2MDYzOTYsImV4cCI6MjA2NDE4MjM5Nn0.-_Pp6zG2v7RiP_0m_pQOEJyAJPn5Zo4yPGCHHJH0IO0';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentChannelId = null;
let localStream = null;
let peers = {};
let peerStreams = {};

const socket = io();

// --- UI Elements ---
const channelsList = document.getElementById('channels-list');
const createChannelBtn = document.getElementById('create-channel-btn');
const newChannelInput = document.getElementById('new-channel-name');
const currentChannelHeader = document.getElementById('current-channel');
const currentChannelNameSpan = document.getElementById('currentChannelName');
const participantsDiv = document.getElementById('participants');
const micToggle = document.getElementById('micToggle');
const logoutBtn = document.getElementById('logout-btn');
const userAvatar = document.getElementById('user-avatar');
const userDisplayName = document.getElementById('user-displayname');
const toast = document.getElementById('toast');
const modal = document.getElementById('modal');
const modalMessage = document.getElementById('modal-message');

// --- Toast & Modal ---
function showToast(message, duration = 3000) {
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, duration);
}
function showModal(message) {
  modalMessage.textContent = message;
  modal.style.display = 'flex';
}
function closeModal() {
  modal.style.display = 'none';
}
window.closeModal = closeModal;

// --- Auth Check & User Info ---
async function checkAuthAndInit() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || !session.user) {
    window.location.href = 'index.html';
    return;
  }
  // Fetch user info from Supabase
  const { data: userData } = await supabase.from('users').select('*').eq('id', session.user.id).single();
  if (!userData) {
    showModal('User not found. Please log in again.');
    setTimeout(() => window.location.href = 'index.html', 2000);
    return;
  }
  currentUser = userData;
  userDisplayName.textContent = userData.display_name;
  userAvatar.textContent = userData.display_name ? userData.display_name[0].toUpperCase() : 'U';
  // Register user with server
  socket.emit('register-user', {
    id: userData.id,
    username: userData.username,
    displayName: userData.display_name
  });
}

// --- Channel Management ---
socket.on('channels-list', (channels) => {
  channelsList.innerHTML = '';
  channels.forEach(ch => {
    const div = document.createElement('div');
    div.className = 'channel-item' + (ch.id === currentChannelId ? ' active' : '');
    div.textContent = `# ${ch.name} (${ch.userCount})`;
    div.onclick = () => joinChannel(ch.id, ch.name);
    channelsList.appendChild(div);
  });
});

createChannelBtn.onclick = () => {
  const name = newChannelInput.value.trim();
  if (!name) return showToast('Enter a channel name');
  socket.emit('create-channel', { name });
  newChannelInput.value = '';
};

// --- Join/Leave Channel ---
function joinChannel(channelId, channelName) {
  if (currentChannelId === channelId) return;
  socket.emit('join-channel', { channelId });
  currentChannelId = channelId;
  currentChannelHeader.textContent = `# ${channelName}`;
  currentChannelNameSpan.textContent = channelName;
  participantsDiv.innerHTML = '';
  // Leave all peer connections
  for (const id in peers) { peers[id].destroy(); delete peers[id]; delete peerStreams[id]; }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  showToast(`Joined channel #${channelName}`);
}
function leaveChannel() {
  if (!currentChannelId) return;
  socket.emit('leave-channel');
  currentChannelHeader.textContent = 'Select a channel';
  currentChannelNameSpan.textContent = '';
  participantsDiv.innerHTML = '';
  for (const id in peers) { peers[id].destroy(); delete peers[id]; delete peerStreams[id]; }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  currentChannelId = null;
  showToast('Left channel');
}
window.leaveChannel = leaveChannel;

// --- Participants & Voice Streaming ---
socket.on('participants', ({ participants }) => {
  participantsDiv.innerHTML = '';
  participants.forEach(({ socketId, displayName }) => {
    addParticipant(socketId, displayName);
    if (socketId !== socket.id && !peers[socketId]) {
      // Only create peer if my socket.id > theirs (initiator)
      if (socket.id > socketId) {
        console.log(`[PEER] Creating initiator peer: me (${socket.id}) > them (${socketId})`);
        connectToNewUser(socketId, displayName, true);
      }
    }
  });
  // Start voice if not already
  if (!localStream) startVoice();
});

socket.on('user-joined', ({ socketId, displayName }) => {
  addParticipant(socketId, displayName, true);
  showToast(`${displayName} joined the channel`);
  // Only create peer if my socket.id < theirs (initiator)
  if (socketId !== socket.id && !peers[socketId] && socket.id < socketId) {
    console.log(`[PEER] Creating initiator peer: me (${socket.id}) < them (${socketId})`);
    connectToNewUser(socketId, displayName, true);
  }
});

socket.on('user-left', ({ socketId }) => {
  document.getElementById('p-' + socketId)?.remove();
  if (peers[socketId]) {
    peers[socketId].destroy();
    delete peers[socketId];
    delete peerStreams[socketId];
    console.log(`[PEER] Destroyed peer for ${socketId}`);
  }
});

function addParticipant(socketId, displayName, animate = false) {
  if (document.getElementById('p-' + socketId)) return;
  const div = document.createElement('div');
  div.id = 'p-' + socketId;
  div.className = animate ? 'participant-join-animate' : '';
  // Active speaker indicator
  const activeCircle = document.createElement('span');
  activeCircle.className = 'active-speaker';
  activeCircle.style.visibility = 'hidden';
  activeCircle.id = 'active-' + socketId;
  div.appendChild(activeCircle);
  div.appendChild(document.createTextNode(displayName));
  participantsDiv.appendChild(div);
}

// --- Voice Streaming (WebRTC) ---
async function startVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micToggle.onclick = () => {
      const micIcon = document.getElementById('micIcon');
      const enabled = localStream.getAudioTracks()[0].enabled = !localStream.getAudioTracks()[0].enabled;
      micIcon.textContent = enabled ? 'mic' : 'mic_off';
      micIcon.classList.add('mic-animate');
      setTimeout(() => micIcon.classList.remove('mic-animate'), 400);
      showToast(enabled ? 'Microphone enabled' : 'Microphone muted');
    };
    // Audio activity detection for local user
    detectSpeaking(localStream, socket.id);
  } catch (err) {
    showModal('Microphone access denied!');
  }
}

// --- Audio Activity Detection ---
function detectSpeaking(stream, socketId) {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = audioContext.createAnalyser();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  analyser.fftSize = 512;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  function checkSpeaking() {
    analyser.getByteFrequencyData(dataArray);
    const volume = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const activeCircle = document.getElementById('active-' + socketId);
    if (activeCircle) {
      activeCircle.style.visibility = (volume > 15 && stream.getAudioTracks()[0].enabled) ? 'visible' : 'hidden';
    }
    requestAnimationFrame(checkSpeaking);
  }
  checkSpeaking();
}

socket.on('signal', ({ id, signal }) => {
  if (!peers[id]) {
    // Always use socket.id comparison to determine initiator
    const initiator = socket.id > id;
    console.log(`[SIGNAL] Creating peer for signal: me (${socket.id}) ${initiator ? '>' : '<'} them (${id}), initiator: ${initiator}`);
    connectToNewUser(id, '', initiator);
  }
  // Only signal if peer exists and not in stable state
  if (peers[id]) {
    try {
      peers[id].signal(signal);
      console.log(`[SIGNAL] Signaled peer ${id}`);
    } catch (e) {
      console.warn(`[SIGNAL] Error signaling peer ${id}:`, e);
    }
  }
});

function connectToNewUser(id, displayName, initiator) {
  if (peers[id]) return; // Prevent duplicate
  const peer = new SimplePeer({
    initiator,
    trickle: false,
    stream: localStream,
  });
  peer.on('signal', signal => {
    socket.emit('signal', { targetId: id, signal });
  });
  peer.on('stream', stream => {
    let audio = document.getElementById('audio-' + id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + id;
      audio.autoplay = true;
      audio.controls = true;
      document.getElementById('p-' + id)?.appendChild(audio);
    }
    audio.srcObject = stream;
    peerStreams[id] = stream;
    // Detect speaking for remote user
    detectSpeaking(stream, id);
  });
  peer.on('close', () => {
    let audio = document.getElementById('audio-' + id);
    if (audio) audio.remove();
    delete peers[id];
    delete peerStreams[id];
  });
  peer.on('error', err => {
    showModal('Connection error: ' + err.message);
  });
  peers[id] = peer;
}

// --- Logout ---
logoutBtn.onclick = async () => {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
};

// --- Error Handling ---
socket.on('error', (err) => {
  showModal(err.message || 'An error occurred');
});

// --- Init ---
checkAuthAndInit();
