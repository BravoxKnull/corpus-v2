const socket = io();
let localStream;
let peers = {};
let currentName = "";

const micToggle = document.getElementById('micToggle');
const toast = document.getElementById('toast');
const modal = document.getElementById('modal');
const modalMessage = document.getElementById('modal-message');

function showToast(message, duration = 3000) {
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => {
    toast.style.display = 'none';
  }, duration);
}

function showModal(message) {
  modalMessage.textContent = message;
  modal.style.display = 'flex';
}

function closeModal() {
  modal.style.display = 'none';
}

async function joinChannel() {
  currentName = document.getElementById('nameSelect').value;
  document.getElementById('currentUser').innerText = currentName;
  document.getElementById('nameSelection').style.display = 'none';
  document.getElementById('voiceRoom').style.display = 'block';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micToggle.onclick = () => {
      const enabled = localStream.getAudioTracks()[0].enabled = !localStream.getAudioTracks()[0].enabled;
      showToast(enabled ? 'Microphone enabled' : 'Microphone muted');
    };
    socket.emit('join-channel', { name: currentName });
    showToast('Joined channel as ' + currentName);
  } catch (err) {
    showModal('Microphone access denied! Please allow microphone access to join the voice chat.');
  }
}

socket.on('all-users', ({ users }) => {
  for (const id in users) {
    if (id === socket.id) continue;
    connectToNewUser(id, users[id], true);
  }
});

socket.on('user-joined', ({ id, name }) => {
  connectToNewUser(id, name, false);
  showToast(`${name} joined the room`);
});

socket.on('signal', ({ id, signal }) => {
  if (peers[id]) {
    peers[id].signal(signal);
  }
});

socket.on('user-left', id => {
  if (peers[id]) {
    peers[id].destroy();
    delete peers[id];
    document.getElementById(id)?.remove();
    showToast('A user left the room');
  }
});

function connectToNewUser(id, name, initiator) {
  const peer = new SimplePeer({
    initiator,
    trickle: false,
    stream: localStream,
  });

  peer.on('signal', signal => {
    socket.emit('signal', { targetId: id, signal });
  });

  peer.on('stream', stream => {
    const audio = document.createElement('audio');
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.controls = true;
    audio.id = id;

    const label = document.createElement('div');
    label.textContent = name;
    label.appendChild(audio);
    document.getElementById('participants').appendChild(label);
  });

  peer.on('error', err => {
    showModal('Connection error: ' + err.message);
  });

  peers[id] = peer;
}

function leave() {
  showToast('You left the room');
  setTimeout(() => {
    location.reload();
  }, 1000);
}

// Expose closeModal globally for modal button
window.closeModal = closeModal;
