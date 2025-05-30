const socket = io();
let localStream;
let peers = {};
let currentName = "";

const micToggle = document.getElementById('micToggle');

async function joinChannel() {
  currentName = document.getElementById('nameSelect').value;
  document.getElementById('currentUser').innerText = currentName;
  document.getElementById('nameSelection').style.display = 'none';
  document.getElementById('voiceRoom').style.display = 'block';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micToggle.onclick = () => {
      localStream.getAudioTracks()[0].enabled = !localStream.getAudioTracks()[0].enabled;
    };

    socket.emit('join-channel', { name: currentName });

  } catch (err) {
    alert('Microphone access denied!');
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

  peers[id] = peer;
}

function leave() {
  location.reload();
}
