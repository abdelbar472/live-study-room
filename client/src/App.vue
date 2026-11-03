<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { io } from 'socket.io-client';

// Empty means same origin: Vite proxies /api and /socket.io in dev, nginx does
// it in Docker. Set VITE_API_URL only for a split client/API deployment.
const API = import.meta.env.VITE_API_URL ?? '';
const token = ref(localStorage.getItem('token'));
const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));
const rooms = ref([]); const selectedRoom = ref(null); const presence = ref([]); const messages = ref([]);
const email = ref(''); const password = ref(''); const name = ref(''); const isRegister = ref(false); const error = ref(''); const chat = ref('');
// Room creation uses an in-app dialog instead of window.prompt(), which is
// blocked in embedded browsers and looks out of place in the UI.
const roomDialogOpen = ref(false); const newRoomName = ref(''); const newRoomSubject = ref(''); const newRoomDescription = ref('');
const roomDialogError = ref(''); const creatingRoom = ref(false); const roomNameInput = ref(null);
let socket;
let refreshPromise = null;
let socketRefreshAttempts = 0;
const initials = (value) => value?.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';

const saveSession = (data) => {
  token.value = data.token; user.value = data.user;
  localStorage.setItem('token', data.token); localStorage.setItem('user', JSON.stringify(data.user));
};
const clearSession = () => {
  localStorage.removeItem('token'); localStorage.removeItem('user');
  token.value = null; user.value = null;
  rooms.value = []; selectedRoom.value = null; presence.value = []; messages.value = [];
  socket?.disconnect(); socket = undefined;
};

// Single-flight refresh: concurrent 401s share one /refresh call, so token
// rotation on the server never sees a replayed (already-rotated) token.
const refreshSession = async () => {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const response = await fetch(`${API}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (!response.ok) { clearSession(); return false; }
        saveSession(await response.json());
        if (socket) socket.auth = { token: token.value };
        return true;
      } catch { clearSession(); return false; }
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

const api = async (path, options = {}, retry = true) => {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}), ...(options.headers || {}) }
  });
  if (response.status === 401 && retry && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) return api(path, options, false);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Something went wrong');
  return data;
};

const loadRooms = async () => { rooms.value = (await api('/api/rooms')).rooms; if (!selectedRoom.value && rooms.value[0]) selectRoom(rooms.value[0]); };
const connectSocket = () => {
  socket?.disconnect();
  const current = io(API || undefined, { auth: { token: token.value } });
  socket = current;
  current.on('connect', () => { socketRefreshAttempts = 0; if (selectedRoom.value) current.emit('room:join', { roomId: selectedRoom.value.id }); });
  current.on('connect_error', async (err) => {
    // A short-lived access token can expire during a long study session, so
    // refresh once before letting Socket.IO keep retrying the handshake.
    if (current !== socket || !/token|auth/i.test(err.message) || socketRefreshAttempts >= 2) return;
    socketRefreshAttempts += 1;
    if (await refreshSession()) { current.auth = { token: token.value }; current.connect(); }
  });
  current.on('presence:update', (items) => { presence.value = items; });
  current.on('chat:message', (message) => messages.value.push(message));
};
const submitAuth = async () => {
  try {
    error.value = '';
    const path = isRegister.value ? '/api/auth/register' : '/api/auth/login';
    const data = await api(path, { method: 'POST', body: JSON.stringify({ name: name.value, email: email.value, password: password.value }) });
    saveSession(data);
    await loadRooms();
    connectSocket();
  } catch (e) { error.value = e.message; }
};
const selectRoom = (room) => { selectedRoom.value = room; presence.value = []; messages.value = []; socket?.emit('room:join', { roomId: room.id }); };
const openRoomDialog = () => {
  newRoomName.value = ''; newRoomSubject.value = ''; newRoomDescription.value = '';
  roomDialogError.value = ''; creatingRoom.value = false;
  roomDialogOpen.value = true;
  nextTick(() => roomNameInput.value?.focus());
};
const closeRoomDialog = () => { if (!creatingRoom.value) roomDialogOpen.value = false; };
const createRoom = async () => {
  const roomName = newRoomName.value.trim();
  if (!roomName) { roomDialogError.value = 'Give your room a name.'; roomNameInput.value?.focus(); return; }
  creatingRoom.value = true; roomDialogError.value = '';
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: roomName,
        subject: newRoomSubject.value.trim() || 'General',
        description: newRoomDescription.value.trim()
      })
    });
    rooms.value.unshift(data.room);
    selectRoom(data.room);
    roomDialogOpen.value = false;
  } catch (e) { roomDialogError.value = e.message; } finally { creatingRoom.value = false; }
};
const sendMessage = () => { if (chat.value.trim() && socket) { socket.emit('chat:send', { roomId: selectedRoom.value.id, text: chat.value }); chat.value = ''; } };
const logout = async () => {
  try { await fetch(`${API}/api/auth/logout`, { method: 'POST', credentials: 'include' }); } catch { /* offline: still clear locally */ }
  clearSession(); error.value = '';
};
const onlineCount = computed(() => presence.value.length);
onMounted(async () => {
  try {
    // No stored access token: try the httpOnly refresh cookie for a silent login.
    if (!token.value && !(await refreshSession())) return;
    await loadRooms();
    connectSocket();
  } catch (e) { error.value = e.message; }
});
</script>

<template>
  <main v-if="!token" class="auth-shell">
    <section class="auth-card"><div class="brand-mark">◒</div><p class="eyebrow">FOCUS TOGETHER</p><h1>Your best work<br><em>happens live.</em></h1><p class="muted">A quiet, focused place to study alongside people who get it.</p>
      <form @submit.prevent="submitAuth"><input v-if="isRegister" v-model="name" placeholder="Your name" required /><input v-model="email" type="email" placeholder="Email address" required /><input v-model="password" type="password" placeholder="Password (6+ characters)" required /><p v-if="error" class="error">{{ error }}</p><button class="primary">{{ isRegister ? 'Create account' : 'Enter your space' }} <span>→</span></button></form>
      <button class="link-button" @click="isRegister = !isRegister; error = ''">{{ isRegister ? 'Already have an account? Sign in' : 'New here? Create an account' }}</button>
    </section>
  </main>
  <main v-else class="app-shell">
    <aside class="sidebar"><div class="logo"><span>◒</span> studyroom</div><div class="profile"><div class="avatar">{{ initials(user.name) }}</div><div><strong>{{ user.name }}</strong><small>Available to focus</small></div><button @click="logout">↗</button></div><div class="side-label">YOUR ROOMS <button @click="openRoomDialog" aria-label="Create a study room">+</button></div><nav><button v-for="room in rooms" :key="room.id" :class="{ active: selectedRoom?.id === room.id }" @click="selectRoom(room)"><span class="room-dot"></span><span>{{ room.name }}</span><small>{{ room.members.length }}</small></button></nav><div class="sidebar-foot"><span>⌘</span> Keyboard shortcuts</div></aside>
    <section class="workspace"><header><div><p class="eyebrow">STUDY ROOM</p><h2>{{ selectedRoom?.name || 'Welcome back' }}</h2></div><div class="header-actions"><span class="live-pill"><i></i> {{ onlineCount }} online</span><button class="icon-button">⋯</button></div></header>
      <div v-if="selectedRoom" class="room-content"><div class="focus-card"><div><p class="eyebrow">CURRENT SESSION</p><h3>{{ selectedRoom.description || 'Deep work, together.' }}</h3><p class="muted">Stay focused. You’re doing great.</p></div><div class="timer"><strong>25:00</strong><small>FOCUS TIMER</small></div></div><div class="section-heading"><div><h3>People in the room</h3><p class="muted">{{ onlineCount }} people are focusing right now</p></div><div class="avatars"><span v-for="person in presence.slice(0, 5)" :key="person.socketId" class="avatar tiny">{{ initials(person.name) }}</span></div></div><div class="people-grid"><div v-for="person in presence" :key="person.socketId" class="person-card"><div class="avatar">{{ initials(person.name) }}</div><div><strong>{{ person.name }}<span v-if="person.id === user.id"> (you)</span></strong><small><i></i> In focus mode</small></div><span class="card-menu">⋯</span></div><div v-if="!presence.length" class="empty-state">Join the room from another window to see people here.</div></div><div class="chat-panel"><div class="chat-heading"><h3>Room chat</h3><span>{{ messages.length }} messages</span></div><div class="messages"><div v-for="message in messages" :key="message.id" class="message"><div class="avatar tiny">{{ initials(message.user.name) }}</div><div><strong>{{ message.user.name }}</strong><p>{{ message.text }}</p></div></div><p v-if="!messages.length" class="muted chat-empty">Say hello to your room.</p></div><form class="chat-form" @submit.prevent="sendMessage"><input v-model="chat" placeholder="Message the room..." /><button class="primary">Send</button></form></div></div><div v-else class="empty-state large">Create a room to start studying together.<button class="primary empty-cta" @click="openRoomDialog">Create a room</button></div>
    </section>
    <div v-if="roomDialogOpen" class="dialog-backdrop" @click.self="closeRoomDialog" @keydown.esc="closeRoomDialog">
      <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="room-dialog-title" @submit.prevent="createRoom">
        <p class="eyebrow">NEW SPACE</p>
        <h3 id="room-dialog-title">Create a study room</h3>
        <p class="muted dialog-intro">Name it after what you're working on. Everyone who joins sees this.</p>
        <label class="field"><span>Room name</span>
          <input ref="roomNameInput" v-model="newRoomName" maxlength="80" aria-label="Room name" placeholder="e.g. Finals week — Calculus" required />
        </label>
        <label class="field"><span>Subject <em>optional</em></span>
          <input v-model="newRoomSubject" maxlength="40" aria-label="Subject (optional)" placeholder="General" />
        </label>
        <label class="field"><span>What are you working on? <em>optional</em></span>
          <textarea v-model="newRoomDescription" maxlength="240" rows="2" aria-label="What are you working on? (optional)" placeholder="Quiet focus, cameras off, check in every hour."></textarea>
        </label>
        <p v-if="roomDialogError" class="error">{{ roomDialogError }}</p>
        <div class="dialog-actions">
          <button type="button" class="ghost" :disabled="creatingRoom" @click="closeRoomDialog">Cancel</button>
          <button class="primary" :disabled="creatingRoom || !newRoomName.trim()">{{ creatingRoom ? 'Creating…' : 'Create room' }}</button>
        </div>
      </form>
    </div>
  </main>
</template>
