// --- Supabase Auth & User Info ---
const SUPABASE_URL = 'https://tlhzsssflsljvvzfyapc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsaHpzc3NmbHNsanZ2emZ5YXBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg2MDYzOTYsImV4cCI6MjA2NDE4MjM5Nn0.-_Pp6zG2v7RiP_0m_pQOEJyAJPn5Zo4yPGCHHJH0IO0';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- WebRTC Configuration ---
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        // Add your TURN servers here for better connectivity
        {
            urls: 'turn:your-turn-server.com:3478',
            username: 'username',
            credential: 'password'
        }
    ],
    iceCandidatePoolSize: 10
};

// --- Global State ---
let currentUser = null;
let currentChannelId = null;
let localStream = null;
let audioContext = null;
let audioDestination = null;
const peers = {};  // Single declaration of peers object
const peerStreams = {};

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
socket.on('participants', async ({ participants }) => {
  participantsDiv.innerHTML = '';
  if (!localStream) await startVoice(); // Ensure mic is ready first
  participants.forEach(({ socketId, displayName }) => {
    addParticipant(socketId, displayName);
    if (socketId !== socket.id && !peers[socketId]) {
      connectToNewUser(socketId, displayName, false); // Always non-initiator for existing users
    }
  });
});

socket.on('user-joined', async ({ socketId, displayName }) => {
  addParticipant(socketId, displayName, true);
  showToast(`${displayName} joined the channel`);
  if (socketId !== socket.id && !peers[socketId]) {
    connectToNewUser(socketId, displayName, true); // Always initiator for new users
  }
});

socket.on('user-left', ({ socketId }) => {
  document.getElementById('p-' + socketId)?.remove();
  if (peers[socketId]) {
    peers[socketId].destroy();
    delete peers[socketId];
    delete peerStreams[socketId];
  }
});

function addParticipant(socketId, displayName, animate = false) {
  if (document.getElementById('p-' + socketId)) return;
  const div = document.createElement('div');
  div.id = 'p-' + socketId;
  div.className = animate ? 'participant-join-animate' : '';
  const activeCircle = document.createElement('span');
  activeCircle.className = 'active-speaker';
  activeCircle.style.visibility = 'hidden';
  activeCircle.id = 'active-' + socketId;
  div.appendChild(activeCircle);
  div.appendChild(document.createTextNode(displayName));
  participantsDiv.appendChild(div);
}

// Initialize voice with optimized audio settings
async function startVoice() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000,
                sampleSize: 16,
                volume: 1.0
            }
        });

        // Apply additional audio processing
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(localStream);
        audioDestination = audioContext.createMediaStreamDestination();
        
        // Add audio processing nodes
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 1.2; // Slight volume boost

        const compressor = audioContext.createDynamicsCompressor();
        compressor.threshold.value = -50;
        compressor.knee.value = 40;
        compressor.ratio.value = 12;
        compressor.attack.value = 0;
        compressor.release.value = 0.25;

        // Connect audio nodes
        source.connect(gainNode);
        gainNode.connect(compressor);
        compressor.connect(audioDestination);

        return audioDestination.stream;
    } catch (err) {
        console.error('Error accessing microphone:', err);
        throw err;
    }
}

// Create and manage peer connection
function connectToNewUser(id, displayName, initiator) {
    const peerConnection = new RTCPeerConnection(configuration);
    
    // Add local stream tracks to peer connection
    audioDestination.stream.getTracks().forEach(track => {
        peerConnection.addTrack(track, audioDestination.stream);
    });

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', {
                targetId: id,
                signal: {
                    type: 'candidate',
                    candidate: event.candidate
                }
            });
        }
    };

    // Handle ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
        console.log(`[PEER] ICE Connection State: ${peerConnection.iceConnectionState}`);
        if (peerConnection.iceConnectionState === 'disconnected' || 
            peerConnection.iceConnectionState === 'failed') {
            reconnectPeer(id);
        }
    };

    // Handle incoming tracks with audio processing
    peerConnection.ontrack = (event) => {
        const [remoteStream] = event.streams;
        
        // Create audio context for remote stream
        const remoteAudioContext = new AudioContext();
        const source = remoteAudioContext.createMediaStreamSource(remoteStream);
        const destination = remoteAudioContext.createMediaStreamDestination();

        // Add audio processing for remote stream
        const gainNode = remoteAudioContext.createGain();
        gainNode.gain.value = 1.0;

        const compressor = remoteAudioContext.createDynamicsCompressor();
        compressor.threshold.value = -50;
        compressor.knee.value = 40;
        compressor.ratio.value = 12;
        compressor.attack.value = 0;
        compressor.release.value = 0.25;

        // Connect audio nodes
        source.connect(gainNode);
        gainNode.connect(compressor);
        compressor.connect(destination);

        // Create audio element for processed stream
        const audio = new Audio();
        audio.srcObject = destination.stream;
        audio.autoplay = true;
        audio.volume = 1.0;
    };

    // Create and send offer if initiator
    if (initiator) {
        createAndSendOffer(peerConnection, id);
    }

    return peerConnection;
}

// Create and send offer
async function createAndSendOffer(peerConnection, targetId) {
    try {
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });
        
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('signal', {
            targetId: targetId,
            signal: {
                type: 'offer',
                sdp: peerConnection.localDescription
            }
        });
    } catch (err) {
        console.error('Error creating offer:', err);
        handleError(err);
    }
}

// Handle incoming signals
socket.on('signal', async (data) => {
    const { signal, fromId } = data;
    let peerConnection = peers[fromId];

    if (!peerConnection) {
        peerConnection = connectToNewUser(fromId, '', false);
        peers[fromId] = peerConnection;
    }

    try {
        if (signal.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            socket.emit('signal', {
                targetId: fromId,
                signal: {
                    type: 'answer',
                    sdp: peerConnection.localDescription
                }
            });
        } else if (signal.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        } else if (signal.type === 'candidate') {
            await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    } catch (err) {
        console.error('Error handling signal:', err);
        handleError(err);
    }
});

// Reconnection logic
async function reconnectPeer(peerId) {
    console.log(`[PEER] Attempting to reconnect to peer ${peerId}`);
    cleanupPeer(peerId);
    const peerConnection = connectToNewUser(peerId, '', true);
    peers[peerId] = peerConnection;
}

// Cleanup peer connection
function cleanupPeer(peerId) {
    if (peers[peerId]) {
        peers[peerId].close();
        delete peers[peerId];
    }
}

// Mute/unmute functionality
function toggleMute() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        audioTrack.enabled = !audioTrack.enabled;
    }
}

// Volume control
function setVolume(volume) {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack.getSettings().volume !== undefined) {
            audioTrack.applyConstraints({
                volume: volume
            });
        }
    }
}

// Error handling
function handleError(err) {
    console.error('[ERROR] WebRTC Error:', err);
    showToast('Connection error occurred. Attempting to reconnect...', 'error');
}

// Initialize voice chat
async function initializeVoiceChat() {
    try {
        await startVoice();
        setupSocketConnection();
    } catch (err) {
        handleError(err);
    }
}

// Set up socket connection
function setupSocketConnection() {
    socket.on('connect', () => {
        console.log('[SOCKET] Connected to signaling server');
    });

    socket.on('disconnect', () => {
        console.log('[SOCKET] Disconnected from signaling server');
        cleanup();
    });
}

// Cleanup all connections
function cleanup() {
    // Stop local stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    // Close audio context
    if (audioContext) {
        audioContext.close();
    }
    
    // Close all peer connections
    Object.keys(peers).forEach(peerId => {
        cleanupPeer(peerId);
    });
}

// Start the voice chat when the page loads
document.addEventListener('DOMContentLoaded', () => {
    initializeVoiceChat();
});

logoutBtn.onclick = async () => {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
};

socket.on('error', (err) => {
  showModal(err.message || 'An error occurred');
});

checkAuthAndInit();
