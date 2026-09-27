/**
 * client.js
 * -----------------------------------------------------------------------
 * Логика фронтенда:
 *  - вход по нику;
 *  - список онлайн-пользователей и выбор собеседника;
 *  - обмен текстовыми сообщениями и фото (base64) через Socket.io;
 *  - аудио/видео звонки через WebRTC, где Socket.io используется только
 *    как канал сигнализации (обмен offer/answer/ICE-кандидатами).
 * -----------------------------------------------------------------------
 */

const socket = io();

// ------------------------- Состояние приложения -------------------------
let myNickname = null;
let currentChatWith = null;          // с кем сейчас открыт чат
let selectedPhotoDataUrl = null;     // base64 прикреплённого фото (ожидает отправки)
const chatHistories = new Map();     // nickname -> [ {from,text,image,ts,own} ]

// WebRTC
let peerConnection = null;
let localStream = null;
let callPartner = null;              // ник собеседника во время звонка
let pendingOffer = null;             // offer входящего звонка (до принятия)
let isCaller = false;

// STUN-сервер Google — нужен для обхода NAT при установке P2P-соединения.
// Для реального прод-использования лучше добавить и свой TURN-сервер.
const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// ------------------------- DOM-элементы -------------------------
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const nicknameInput = document.getElementById('nickname-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const myNicknameEl = document.getElementById('my-nickname');
const usersListEl = document.getElementById('users-list');
const chatWithEl = document.getElementById('chat-with');
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const photoInput = document.getElementById('photo-input');
const photoPreview = document.getElementById('photo-preview');
const audioCallBtn = document.getElementById('audio-call-btn');
const videoCallBtn = document.getElementById('video-call-btn');

const callModal = document.getElementById('call-modal');
const callStatus = document.getElementById('call-status');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const acceptCallBtn = document.getElementById('accept-call-btn');
const rejectCallBtn = document.getElementById('reject-call-btn');

// ========================================================================
// 1. ВХОД ПО НИКНЕЙМУ
// ========================================================================

loginBtn.addEventListener('click', doLogin);
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

function doLogin() {
  const nickname = nicknameInput.value.trim();
  if (!nickname) return;

  socket.emit('login', nickname, (res) => {
    if (!res.ok) {
      loginError.textContent = res.error;
      return;
    }
    myNickname = res.nickname;
    myNicknameEl.textContent = myNickname;
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
  });
}

// Сервер присылает обновлённый список пользователей онлайн
socket.on('users-list', (nicknames) => {
  usersListEl.innerHTML = '';
  nicknames
    .filter((n) => n !== myNickname)
    .forEach((nick) => {
      const li = document.createElement('li');
      li.textContent = nick;
      li.dataset.nick = nick;
      if (nick === currentChatWith) li.classList.add('active');
      li.addEventListener('click', () => openChat(nick));
      usersListEl.appendChild(li);
    });
});

// ========================================================================
// 2. ТЕКСТОВЫЙ ЧАТ + ФОТО
// ========================================================================

function openChat(nick) {
  currentChatWith = nick;
  chatWithEl.textContent = nick;
  messageInput.disabled = false;
  sendBtn.disabled = false;
  audioCallBtn.disabled = false;
  videoCallBtn.disabled = false;

  // подсветить активного пользователя в списке
  [...usersListEl.children].forEach((li) => {
    li.classList.toggle('active', li.dataset.nick === nick);
  });

  renderMessages(nick);
}

function renderMessages(nick) {
  messagesEl.innerHTML = '';
  const history = chatHistories.get(nick) || [];
  history.forEach(addMessageToDom);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessageToDom(msg) {
  const div = document.createElement('div');
  div.className = 'msg' + (msg.own ? ' own' : '');

  if (msg.text) {
    const p = document.createElement('div');
    p.textContent = msg.text;
    div.appendChild(p);
  }
  if (msg.image) {
    const img = document.createElement('img');
    img.src = msg.image;
    div.appendChild(img);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = (msg.own ? 'Вы' : msg.from) + ' · ' + new Date(msg.ts).toLocaleTimeString();
  div.appendChild(meta);

  messagesEl.appendChild(div);
}

// Прикрепление фото: читаем файл как base64 data-URL и показываем превью
photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    selectedPhotoDataUrl = reader.result;
    photoPreview.src = selectedPhotoDataUrl;
    photoPreview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

// Отправка сообщения (текст и/или фото)
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentChatWith) return;

  const text = messageInput.value.trim();
  if (!text && !selectedPhotoDataUrl) return;

  socket.emit('private-message', {
    to: currentChatWith,
    text,
    image: selectedPhotoDataUrl,
    ts: Date.now(),
  });

  messageInput.value = '';
  selectedPhotoDataUrl = null;
  photoPreview.classList.add('hidden');
  photoInput.value = '';
});

// Приём сообщения (своего же — как подтверждение, либо от собеседника)
socket.on('private-message', (msg) => {
  const partner = msg.self ? msg.to : msg.from;
  const stored = { ...msg, own: !!msg.self };

  if (!chatHistories.has(partner)) chatHistories.set(partner, []);
  chatHistories.get(partner).push(stored);

  if (partner === currentChatWith) {
    addMessageToDom(stored);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
});

// ========================================================================
// 3. ЗВОНКИ (WebRTC)
// ========================================================================

audioCallBtn.addEventListener('click', () => startCall('audio'));
videoCallBtn.addEventListener('click', () => startCall('video'));

/** Создаёт RTCPeerConnection и подключает обработчики */
function createPeerConnection() {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  // Отправляем каждому найденному ICE-кандидату собеседнику через сервер
  pc.onicecandidate = (event) => {
    if (event.candidate && callPartner) {
      socket.emit('ice-candidate', { to: callPartner, candidate: event.candidate });
    }
  };

  // Как только приходит удалённый медиапоток — показываем его в видео-теге
  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  return pc;
}

/** Инициатор начинает звонок */
async function startCall(callType) {
  if (!currentChatWith) return;
  callPartner = currentChatWith;
  isCaller = true;

  showCallModal(`Звонок пользователю ${callPartner}...`, false);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    });
  } catch (err) {
    alert('Не удалось получить доступ к камере/микрофону: ' + err.message);
    closeCallModal();
    return;
  }

  localVideo.srcObject = localStream;

  peerConnection = createPeerConnection();
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit('call-user', { to: callPartner, offer, callType });
}

// Входящий звонок
socket.on('incoming-call', ({ from, offer, callType }) => {
  // Простая реализация: если уже идёт звонок — сразу отклоняем новый
  if (peerConnection) {
    socket.emit('end-call', { to: from });
    return;
  }

  callPartner = from;
  pendingOffer = offer;
  isCaller = false;

  showCallModal(
    `Входящий ${callType === 'video' ? 'видео' : 'аудио'}-звонок от ${from}`,
    true,
    callType
  );
});

acceptCallBtn.addEventListener('click', async () => {
  acceptCallBtn.classList.add('hidden');
  callStatus.textContent = `Соединение с ${callPartner}...`;

  const wantsVideo = pendingOffer.sdp.includes('m=video');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: wantsVideo,
    });
  } catch (err) {
    alert('Не удалось получить доступ к камере/микрофону: ' + err.message);
    socket.emit('end-call', { to: callPartner });
    closeCallModal();
    return;
  }

  localVideo.srcObject = localStream;

  peerConnection = createPeerConnection();
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingOffer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('answer-call', { to: callPartner, answer });
  pendingOffer = null;
});

// Инициатору пришёл ответ от собеседника
socket.on('call-answered', async ({ answer }) => {
  callStatus.textContent = `Соединение с ${callPartner}...`;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
});

// Обмен ICE-кандидатами
socket.on('ice-candidate', async ({ candidate }) => {
  if (peerConnection && candidate) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Ошибка добавления ICE-кандидата', err);
    }
  }
});

// Собеседник завершил/отклонил звонок
socket.on('call-ended', () => {
  cleanupCall();
});

socket.on('call-failed', ({ reason }) => {
  alert('Звонок не удался: ' + reason);
  cleanupCall();
});

// Кнопка "Завершить" — работает и для отклонения входящего, и для завершения активного
rejectCallBtn.addEventListener('click', () => {
  if (callPartner) {
    socket.emit('end-call', { to: callPartner });
  }
  cleanupCall();
});

function showCallModal(statusText, showAccept) {
  callStatus.textContent = statusText;
  acceptCallBtn.classList.toggle('hidden', !showAccept);
  callModal.classList.remove('hidden');
}

function closeCallModal() {
  callModal.classList.add('hidden');
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
}

/** Полная остановка звонка: закрываем соединение, останавливаем медиапотоки */
function cleanupCall() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  callPartner = null;
  pendingOffer = null;
  isCaller = false;
  closeCallModal();
}
