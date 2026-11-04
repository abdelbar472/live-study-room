<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { io } from 'socket.io-client';

// Empty means same origin: Vite proxies /api and /socket.io in dev, nginx does
// it in Docker. Set VITE_API_URL only for a split client/API deployment.
const API = import.meta.env.VITE_API_URL ?? '';
const token = ref(localStorage.getItem('token'));
const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));
const rooms = ref([]);
const selectedRoom = ref(null);
const presence = ref([]);
const messages = ref([]);
const onlineUserIds = ref([]);

// Friends, requests, and invitations
const friends = ref([]);
const friendRequests = ref({ incoming: [], outgoing: [] });
const roomInvitations = ref([]);
const ownedJoinRequests = ref([]);
const selectedJoinRequests = ref([]);

const email = ref('');
const password = ref('');
const name = ref('');
const isRegister = ref(false);
const error = ref('');
const chat = ref('');
const fileInput = ref(null);
const pendingAttachment = ref(null);
const uploading = ref(false);
const joinRequestMessage = ref('');
const requestingJoin = ref(false);
const notifications = ref([]);

// Room creation dialog
const roomDialogOpen = ref(false);
const newRoomName = ref('');
const newRoomSubject = ref('');
const newRoomDescription = ref('');
const newRoomVisibility = ref('public');
const roomDialogError = ref('');
const creatingRoom = ref(false);
const roomNameInput = ref(null);

// Profile dialog
const profileDialogOpen = ref(false);
const profileName = ref('');
const profileStatus = ref('');
const profileBio = ref('');
const profileColor = ref('#394a39');
const profileError = ref('');
const savingProfile = ref(false);
const avatarColors = ['#394a39', '#4c5a3a', '#3a4a5b', '#5b3a4a', '#5b4a3a', '#52523a'];

// Friends dialog
const friendsDialogOpen = ref(false);
const friendSearch = ref('');
const friendSearchResults = ref([]);
const friendSearching = ref(false);

// Activity / inbox dialog
const activityDialogOpen = ref(false);

// Invite-to-room dialog
const inviteDialogOpen = ref(false);
const invitedUserIds = ref([]);

let socket;
let refreshPromise = null;
let socketRefreshAttempts = 0;

const initials = (value) => value?.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';
const avatarStyle = (color) => ({ background: color || '#394a39' });
const isOnline = (id) => onlineUserIds.value.includes(id);
const onlineFriendsCount = computed(() => friends.value.filter((friend) => isOnline(friend.id)).length);
const onlineCount = computed(() => presence.value.length);
const activityCount = computed(() => friendRequests.value.incoming.length + roomInvitations.value.length + ownedJoinRequests.value.length);
const hasActivity = computed(() => activityCount.value > 0 || friendRequests.value.outgoing.length > 0);
const selectedInvitation = computed(() => roomInvitations.value.find((invite) => invite.room?.id === selectedRoom.value?.id));
const inviteCandidates = computed(() => friends.value.filter((friend) => !selectedRoom.value?.members.includes(friend.id)));
const canInviteToRoom = computed(() => Boolean(selectedRoom.value?.isOwner));
const formatBytes = (bytes) => {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB'];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit && value < 10 ? 1 : 0)} ${units[unit]}`;
};
const isImageAttachment = (attachment) => attachment?.type?.startsWith('image/');
const attachmentUrl = (url) => (url?.startsWith('http') ? url : `${API}${url}`);

const notify = (message) => {
  const id = `${Date.now()}-${Math.random()}`;
  notifications.value.push({ id, message });
  setTimeout(() => { notifications.value = notifications.value.filter((item) => item.id !== id); }, 5000);
};

const saveSession = (data) => {
  token.value = data.token; user.value = data.user;
  localStorage.setItem('token', data.token); localStorage.setItem('user', JSON.stringify(data.user));
};
const clearSession = () => {
  localStorage.removeItem('token'); localStorage.removeItem('user');
  token.value = null; user.value = null;
  rooms.value = []; selectedRoom.value = null; presence.value = []; messages.value = [];
  friends.value = []; friendRequests.value = { incoming: [], outgoing: [] }; roomInvitations.value = [];
  ownedJoinRequests.value = []; selectedJoinRequests.value = []; onlineUserIds.value = [];
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

const loadRooms = async () => {
  const data = await api('/api/rooms');
  rooms.value = data.rooms;
  if (selectedRoom.value) {
    const fresh = rooms.value.find((room) => room.id === selectedRoom.value.id);
    if (fresh) selectedRoom.value = fresh;
  }
  if (!selectedRoom.value && rooms.value.length) {
    // Prefer a room the user already belongs to; otherwise show the newest one
    // (public rooms join automatically, invite-only rooms show the lock panel).
    await selectRoom(rooms.value.find((room) => room.isMember) || rooms.value[0]);
  }
};
const loadFriends = async () => {
  const [friendData, requestData] = await Promise.all([api('/api/friends'), api('/api/friends/requests')]);
  friends.value = friendData.friends;
  friendRequests.value = requestData;
};
const loadRoomInvitations = async () => {
  roomInvitations.value = (await api('/api/rooms/invitations')).invitations;
};
const loadOwnedJoinRequests = async () => {
  ownedJoinRequests.value = (await api('/api/rooms/join-requests')).requests;
};
const loadSelectedJoinRequests = async () => {
  if (!selectedRoom.value?.isOwner) { selectedJoinRequests.value = []; return; }
  selectedJoinRequests.value = (await api(`/api/rooms/${selectedRoom.value.id}/join-requests`)).requests;
};
const loadInbox = async () => {
  await Promise.allSettled([loadFriends(), loadRoomInvitations(), loadOwnedJoinRequests()]);
};

const connectSocket = () => {
  socket?.disconnect();
  const current = io(API || undefined, { auth: { token: token.value } });
  socket = current;
  current.on('connect', () => {
    socketRefreshAttempts = 0;
    if (selectedRoom.value?.isMember) current.emit('room:join', { roomId: selectedRoom.value.id });
  });
  current.on('connect_error', async (err) => {
    // A short-lived access token can expire during a long study session, so
    // refresh once before letting Socket.IO keep retrying the handshake.
    if (current !== socket || !/token|auth/i.test(err.message) || socketRefreshAttempts >= 2) return;
    socketRefreshAttempts += 1;
    if (await refreshSession()) { current.auth = { token: token.value }; current.connect(); }
  });
  current.on('presence:update', (items) => { presence.value = items; });
  current.on('presence:online', ({ userIds }) => { onlineUserIds.value = userIds || []; });
  current.on('chat:message', (message) => messages.value.push(message));
  current.on('room:error', (message) => notify(message));
  current.on('notification', (notification) => notify(notification.message));
  current.on('friends:updated', () => { loadFriends().catch(() => {}); });
  current.on('room:invitations:updated', () => { loadRoomInvitations().catch(() => {}); });
  current.on('room:requests:updated', () => {
    loadOwnedJoinRequests().catch(() => {});
    loadSelectedJoinRequests().catch(() => {});
  });
  current.on('rooms:updated', async () => {
    try { await loadRooms(); } catch { /* ignore a stale reload */ }
    loadRoomInvitations().catch(() => {});
    loadOwnedJoinRequests().catch(() => {});
    if (selectedRoom.value?.isOwner) loadSelectedJoinRequests().catch(() => {});
  });
  current.on('room:members:updated', () => { loadRooms().catch(() => {}); });
};

const submitAuth = async () => {
  try {
    error.value = '';
    const path = isRegister.value ? '/api/auth/register' : '/api/auth/login';
    const data = await api(path, { method: 'POST', body: JSON.stringify({ name: name.value, email: email.value, password: password.value }) });
    saveSession(data);
    await loadRooms();
    await loadInbox();
    connectSocket();
  } catch (e) { error.value = e.message; }
};

const selectRoom = async (room) => {
  if (!room) return;
  selectedRoom.value = room;
  presence.value = [];
  messages.value = [];
  selectedJoinRequests.value = [];
  if (!room.isMember && room.visibility === 'public') {
    try {
      const data = await api(`/api/rooms/${room.id}/join`, { method: 'POST' });
      Object.assign(room, data.room);
    } catch (e) { notify(e.message); return; }
  }
  if (!room.isMember) return;
  socket?.emit('room:join', { roomId: room.id });
  if (room.isOwner) loadSelectedJoinRequests().catch(() => {});
};

const openRoomDialog = () => {
  newRoomName.value = ''; newRoomSubject.value = ''; newRoomDescription.value = ''; newRoomVisibility.value = 'public';
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
        description: newRoomDescription.value.trim(),
        visibility: newRoomVisibility.value
      })
    });
    rooms.value.unshift(data.room);
    await selectRoom(data.room);
    roomDialogOpen.value = false;
  } catch (e) { roomDialogError.value = e.message; } finally { creatingRoom.value = false; }
};

const openProfileDialog = () => {
  profileName.value = user.value.name;
  profileStatus.value = user.value.statusText || '';
  profileBio.value = user.value.bio || '';
  profileColor.value = user.value.avatarColor || '#394a39';
  profileError.value = '';
  profileDialogOpen.value = true;
};
const saveProfile = async () => {
  savingProfile.value = true; profileError.value = '';
  try {
    const data = await api('/api/users/me', {
      method: 'PATCH',
      body: JSON.stringify({
        name: profileName.value,
        statusText: profileStatus.value,
        bio: profileBio.value,
        avatarColor: profileColor.value
      })
    });
    user.value = data.user;
    localStorage.setItem('user', JSON.stringify(data.user));
    presence.value = presence.value.map((person) => person.id === data.user.id
      ? { ...person, name: data.user.name, avatarColor: data.user.avatarColor, statusText: data.user.statusText }
      : person);
    profileDialogOpen.value = false;
    notify('Profile updated.');
  } catch (e) { profileError.value = e.message; } finally { savingProfile.value = false; }
};

const openFriendsDialog = async () => {
  friendsDialogOpen.value = true;
  friendSearchResults.value = [];
  friendSearch.value = '';
  try { await loadFriends(); } catch (e) { notify(e.message); }
};
const searchUsers = async () => {
  const query = friendSearch.value.trim();
  if (query.length < 2) { friendSearchResults.value = []; return; }
  friendSearching.value = true;
  try {
    friendSearchResults.value = (await api(`/api/users/search?q=${encodeURIComponent(query)}`)).users;
  } catch (e) { notify(e.message); } finally { friendSearching.value = false; }
};
const sendFriendRequest = async (target) => {
  try {
    await api('/api/friends/requests', { method: 'POST', body: JSON.stringify({ userId: target.id }) });
    target.relationship = 'outgoing';
    notify(`Friend request sent to ${target.name}.`);
    await loadFriends();
  } catch (e) { notify(e.message); }
};
const acceptFriendRequest = async (request) => {
  try {
    await api(`/api/friends/requests/${request.id}/accept`, { method: 'POST' });
    notify(`You are now friends with ${request.user.name}.`);
    await loadFriends();
  } catch (e) { notify(e.message); }
};
const declineFriendRequest = async (request) => {
  try {
    await api(`/api/friends/requests/${request.id}/decline`, { method: 'POST' });
    await loadFriends();
  } catch (e) { notify(e.message); }
};
const cancelFriendRequest = async (request) => {
  try {
    await api(`/api/friends/requests/${request.id}`, { method: 'DELETE' });
    await loadFriends();
  } catch (e) { notify(e.message); }
};
const unfriend = async (friend) => {
  try {
    await api(`/api/friends/${friend.id}`, { method: 'DELETE' });
    notify(`Removed ${friend.name} from your friends.`);
    await loadFriends();
  } catch (e) { notify(e.message); }
};

const openActivity = async () => {
  activityDialogOpen.value = true;
  await loadInbox();
};
const acceptInvitation = async (invitation) => {
  try {
    const data = await api(`/api/rooms/invitations/${invitation.id}/accept`, { method: 'POST' });
    roomInvitations.value = roomInvitations.value.filter((item) => item.id !== invitation.id);
    await loadRooms();
    const room = rooms.value.find((item) => item.id === data.room.id) || data.room;
    await selectRoom(room);
    notify(`Joined ${data.room.name}.`);
  } catch (e) { notify(e.message); }
};
const declineInvitation = async (invitation) => {
  try {
    await api(`/api/rooms/invitations/${invitation.id}/decline`, { method: 'POST' });
    roomInvitations.value = roomInvitations.value.filter((item) => item.id !== invitation.id);
  } catch (e) { notify(e.message); }
};
const respondJoinRequest = async (request, action) => {
  try {
    await api(`/api/rooms/${request.room.id}/join-requests/${request.id}/${action}`, { method: 'POST' });
    notify(action === 'accept' ? `${request.user.name} can now join ${request.room.name}.` : 'Join request declined.');
    await loadOwnedJoinRequests();
    await loadRooms();
    if (selectedRoom.value?.id === request.room.id) await loadSelectedJoinRequests();
  } catch (e) { notify(e.message); }
};
const requestToJoin = async () => {
  if (!selectedRoom.value) return;
  requestingJoin.value = true;
  try {
    const data = await api(`/api/rooms/${selectedRoom.value.id}/join-requests`, {
      method: 'POST',
      body: JSON.stringify({ message: joinRequestMessage.value.trim() })
    });
    const room = rooms.value.find((item) => item.id === selectedRoom.value.id);
    const status = data.request?.status || 'pending';
    if (room) room.myRequestStatus = status;
    selectedRoom.value = { ...selectedRoom.value, myRequestStatus: status };
    joinRequestMessage.value = '';
    notify('Join request sent to the room creator.');
  } catch (e) { notify(e.message); } finally { requestingJoin.value = false; }
};
const openInviteDialog = async () => {
  inviteDialogOpen.value = true;
  invitedUserIds.value = [];
  try { await loadFriends(); } catch (e) { notify(e.message); }
};
const inviteFriend = async (friend) => {
  if (!selectedRoom.value) return;
  try {
    await api(`/api/rooms/${selectedRoom.value.id}/invitations`, { method: 'POST', body: JSON.stringify({ userId: friend.id }) });
    invitedUserIds.value.push(friend.id);
    notify(`Invited ${friend.name} to ${selectedRoom.value.name}.`);
  } catch (e) { notify(e.message); }
};

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});
const onFileSelected = async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { notify('Attachments must be 5 MB or smaller.'); return; }
  try {
    pendingAttachment.value = {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      data: await readFileAsDataUrl(file)
    };
  } catch { notify('Could not read that file.'); }
};
const sendMessage = async () => {
  if (!selectedRoom.value || !socket) return;
  if (!chat.value.trim() && !pendingAttachment.value) return;
  uploading.value = true;
  try {
    let attachment = null;
    if (pendingAttachment.value) {
      const data = await api(`/api/rooms/${selectedRoom.value.id}/attachments`, {
        method: 'POST',
        body: JSON.stringify(pendingAttachment.value)
      });
      attachment = data.attachment;
    }
    socket.emit('chat:send', { roomId: selectedRoom.value.id, text: chat.value, attachment });
    chat.value = '';
    pendingAttachment.value = null;
  } catch (e) { notify(e.message); } finally { uploading.value = false; }
};

const logout = async () => {
  try { await fetch(`${API}/api/auth/logout`, { method: 'POST', credentials: 'include' }); } catch { /* offline: still clear locally */ }
  clearSession(); error.value = '';
};

onMounted(async () => {
  try {
    // No stored access token: try the httpOnly refresh cookie for a silent login.
    if (!token.value && !(await refreshSession())) return;
    await loadRooms();
    await loadInbox();
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
    <aside class="sidebar">
      <div class="logo"><span>◒</span> studyroom</div>
      <div class="profile clickable" title="Edit your profile" @click="openProfileDialog">
        <div class="avatar" :style="avatarStyle(user.avatarColor)">{{ initials(user.name) }}</div>
        <div><strong>{{ user.name }}</strong><small>{{ user.statusText || 'Available to focus' }}</small></div>
        <button title="Sign out" @click.stop="logout">↗</button>
      </div>

      <div class="sidebar-tools">
        <button class="side-action" @click="openFriendsDialog"><span>Friends</span><small v-if="friendRequests.incoming.length">{{ friendRequests.incoming.length }}</small></button>
        <button class="side-action" @click="openActivity"><span>Inbox</span><small v-if="activityCount">{{ activityCount }}</small></button>
      </div>

      <div class="side-label">FRIENDS <small>{{ onlineFriendsCount }} online</small></div>
      <div class="friend-mini-list">
        <button v-for="friend in friends.slice(0, 5)" :key="friend.id" class="friend-mini" @click="openFriendsDialog">
          <span class="avatar tiny" :style="avatarStyle(friend.avatarColor)">{{ initials(friend.name) }}</span>
          <span>{{ friend.name }}</span>
          <i class="online-dot" :class="{ online: isOnline(friend.id) }"></i>
        </button>
        <button v-if="!friends.length" class="friend-mini muted" @click="openFriendsDialog">Add friends to study together →</button>
      </div>

      <div class="side-label">YOUR ROOMS <button aria-label="Create a study room" @click="openRoomDialog">+</button></div>
      <nav>
        <button v-for="room in rooms" :key="room.id" :class="{ active: selectedRoom?.id === room.id }" @click="selectRoom(room)">
          <span class="room-dot" :class="{ locked: room.visibility === 'invite' }"></span>
          <span>{{ room.name }} <em v-if="room.visibility === 'invite'" class="lock">invite</em></span>
          <small>{{ room.members.length }}</small>
        </button>
      </nav>
      <div class="sidebar-foot"><span>⌘</span> Keyboard shortcuts</div>
    </aside>

    <section class="workspace">
      <header>
        <div><p class="eyebrow">STUDY ROOM</p><h2>{{ selectedRoom?.name || 'Welcome back' }}</h2></div>
        <div class="header-actions">
          <span class="live-pill"><i></i> {{ selectedRoom?.isMember ? onlineCount : 0 }} in room</span>
          <button v-if="selectedRoom?.isOwner" class="ghost small" @click="openInviteDialog">Invite friends</button>
          <button class="icon-button" title="Inbox" @click="openActivity">⋯</button>
        </div>
      </header>

      <div v-if="selectedRoom && selectedRoom.isMember" class="room-content">
        <div v-if="selectedRoom.isOwner && selectedJoinRequests.length" class="owner-requests">
          <div class="section-heading"><div><h3>Join requests</h3><p class="muted">People asking to enter this invite-only room</p></div><span class="count-pill">{{ selectedJoinRequests.length }}</span></div>
          <div v-for="request in selectedJoinRequests" :key="request.id" class="request-card">
            <div class="avatar tiny" :style="avatarStyle(request.user.avatarColor)">{{ initials(request.user.name) }}</div>
            <div class="request-copy"><strong>{{ request.user.name }}</strong><small>{{ request.user.email }}</small><p v-if="request.message">{{ request.message }}</p></div>
            <div class="row-actions"><button class="primary small" @click="respondJoinRequest(request, 'accept')">Accept</button><button class="ghost small" @click="respondJoinRequest(request, 'decline')">Decline</button></div>
          </div>
        </div>

        <div class="focus-card"><div><p class="eyebrow">CURRENT SESSION</p><h3>{{ selectedRoom.description || 'Deep work, together.' }}</h3><p class="muted">Stay focused. You’re doing great.</p></div><div class="timer"><strong>25:00</strong><small>FOCUS TIMER</small></div></div>
        <div class="section-heading"><div><h3>People in the room</h3><p class="muted">{{ onlineCount }} people are focusing right now</p></div><div class="avatars"><span v-for="person in presence.slice(0, 5)" :key="person.socketId" class="avatar tiny" :style="avatarStyle(person.avatarColor)">{{ initials(person.name) }}</span></div></div>
        <div class="people-grid">
          <div v-for="person in presence" :key="person.socketId" class="person-card">
            <div class="avatar" :style="avatarStyle(person.avatarColor)">{{ initials(person.name) }}</div>
            <div><strong>{{ person.name }}<span v-if="person.id === user.id"> (you)</span></strong><small><i></i> {{ person.statusText || 'In focus mode' }}</small></div>
            <span class="card-menu">⋯</span>
          </div>
          <div v-if="!presence.length" class="empty-state">Join the room from another window to see people here.</div>
        </div>

        <div class="chat-panel">
          <div class="chat-heading"><h3>Room chat</h3><span>{{ messages.length }} messages</span></div>
          <div class="messages">
            <div v-for="message in messages" :key="message.id" class="message">
              <div class="avatar tiny" :style="avatarStyle(message.user.avatarColor)">{{ initials(message.user.name) }}</div>
              <div class="message-body">
                <strong>{{ message.user.name }}</strong>
                <p v-if="message.text">{{ message.text }}</p>
                <template v-if="message.attachment">
                  <a v-if="isImageAttachment(message.attachment)" :href="attachmentUrl(message.attachment.url)" target="_blank" rel="noopener" class="message-image">
                    <img :src="attachmentUrl(message.attachment.url)" :alt="message.attachment.name" />
                  </a>
                  <a v-else :href="attachmentUrl(message.attachment.url)" target="_blank" rel="noopener" class="message-file">📎 {{ message.attachment.name }} <small>{{ formatBytes(message.attachment.size) }}</small></a>
                </template>
              </div>
            </div>
            <p v-if="!messages.length" class="muted chat-empty">Say hello to your room.</p>
          </div>
          <div v-if="pendingAttachment" class="pending-attachment">
            <span>📎 {{ pendingAttachment.name }} <small>{{ formatBytes(pendingAttachment.size) }}</small></span>
            <button type="button" @click="pendingAttachment = null">Remove</button>
          </div>
          <form class="chat-form" @submit.prevent="sendMessage">
            <input ref="fileInput" type="file" hidden accept="image/*,.pdf,.txt,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.mp3,.m4a,.mp4" @change="onFileSelected" />
            <button type="button" class="attach-button" title="Attach a file" :disabled="uploading" @click="fileInput?.click()">📎</button>
            <input v-model="chat" placeholder="Message the room..." />
            <button class="primary" :disabled="uploading">{{ uploading ? 'Sending…' : 'Send' }}</button>
          </form>
        </div>
      </div>

      <div v-else-if="selectedRoom" class="room-content">
        <div class="room-lock">
          <p class="eyebrow">{{ selectedRoom.visibility === 'invite' ? 'INVITE ONLY' : 'JOIN ROOM' }}</p>
          <h3>{{ selectedRoom.name }}</h3>
          <p class="muted">{{ selectedRoom.description || 'This room has not added a description yet.' }}</p>
          <template v-if="selectedRoom.visibility === 'public'">
            <button class="primary" @click="selectRoom(selectedRoom)">Join room</button>
          </template>
          <template v-else-if="selectedInvitation">
            <p class="request-note">{{ selectedInvitation.inviter?.name || 'The room creator' }} invited you to join.</p>
            <button class="primary" @click="acceptInvitation(selectedInvitation)">Accept invitation</button>
          </template>
          <template v-else-if="selectedRoom.myRequestStatus === 'pending'">
            <p class="request-note">Your request is waiting for the room creator.</p>
          </template>
          <form v-else class="join-request-form" @submit.prevent="requestToJoin">
            <label class="field"><span>Message to the creator <em>optional</em></span><textarea v-model="joinRequestMessage" maxlength="200" rows="2" placeholder="Hi! I'd love to join and study with you."></textarea></label>
            <div class="dialog-actions"><button class="primary" :disabled="requestingJoin">{{ requestingJoin ? 'Sending…' : 'Ask to join' }}</button></div>
          </form>
        </div>
      </div>

      <div v-else class="empty-state large">Create a room to start studying together.<button class="primary empty-cta" @click="openRoomDialog">Create a room</button></div>
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
        <label class="field"><span>Who can join?</span>
          <select v-model="newRoomVisibility" aria-label="Room visibility">
            <option value="public">Anyone can join</option>
            <option value="invite">Invite only — invitees or approved requests</option>
          </select>
        </label>
        <p v-if="roomDialogError" class="error">{{ roomDialogError }}</p>
        <div class="dialog-actions">
          <button type="button" class="ghost" :disabled="creatingRoom" @click="closeRoomDialog">Cancel</button>
          <button class="primary" :disabled="creatingRoom || !newRoomName.trim()">{{ creatingRoom ? 'Creating…' : 'Create room' }}</button>
        </div>
      </form>
    </div>

    <div v-if="profileDialogOpen" class="dialog-backdrop" @click.self="profileDialogOpen = false" @keydown.esc="profileDialogOpen = false">
      <form class="dialog" role="dialog" aria-modal="true" @submit.prevent="saveProfile">
        <p class="eyebrow">YOUR PROFILE</p>
        <h3>How friends see you</h3>
        <p class="muted dialog-intro">Your status shows next to your name in every room.</p>
        <label class="field"><span>Name</span><input v-model="profileName" maxlength="40" required /></label>
        <label class="field"><span>Status <em>optional</em></span><input v-model="profileStatus" maxlength="60" placeholder="Calculus finals, day 3" /></label>
        <label class="field"><span>Bio <em>optional</em></span><textarea v-model="profileBio" maxlength="240" rows="3" placeholder="What are you studying right now?"></textarea></label>
        <div class="field"><span>Avatar color</span>
          <div class="color-swatches">
            <button v-for="color in avatarColors" :key="color" type="button" :class="{ active: profileColor === color }" :style="{ background: color }" :aria-label="`Use ${color}`" @click="profileColor = color"></button>
          </div>
        </div>
        <p v-if="profileError" class="error">{{ profileError }}</p>
        <div class="dialog-actions">
          <button type="button" class="ghost" :disabled="savingProfile" @click="profileDialogOpen = false">Cancel</button>
          <button class="primary" :disabled="savingProfile || !profileName.trim()">{{ savingProfile ? 'Saving…' : 'Save profile' }}</button>
        </div>
      </form>
    </div>

    <div v-if="friendsDialogOpen" class="dialog-backdrop" @click.self="friendsDialogOpen = false" @keydown.esc="friendsDialogOpen = false">
      <div class="dialog wide" role="dialog" aria-modal="true">
        <div class="dialog-heading"><div><p class="eyebrow">FRIENDS</p><h3>Your study circle</h3></div><button class="icon-button" @click="friendsDialogOpen = false">×</button></div>
        <form class="search-form" @submit.prevent="searchUsers">
          <input v-model="friendSearch" placeholder="Search by name or email" aria-label="Search people" />
          <button class="ghost small" :disabled="friendSearching || friendSearch.trim().length < 2">{{ friendSearching ? 'Searching…' : 'Search' }}</button>
        </form>
        <div v-if="friendSearchResults.length" class="dialog-section">
          <h4>Search results <span>{{ friendSearchResults.length }}</span></h4>
          <div v-for="result in friendSearchResults" :key="result.id" class="friend-row">
            <span class="avatar tiny" :style="avatarStyle(result.avatarColor)">{{ initials(result.name) }}</span>
            <div class="friend-meta"><strong>{{ result.name }} <i class="online-dot" :class="{ online: isOnline(result.id) }"></i></strong><small>{{ result.statusText || result.email }}</small></div>
            <div class="row-actions">
              <button v-if="result.relationship === 'none'" class="primary small" @click="sendFriendRequest(result)">Add friend</button>
              <span v-else-if="result.relationship === 'outgoing'" class="muted small-text">Request sent</span>
              <span v-else-if="result.relationship === 'incoming'" class="muted small-text">Check your inbox</span>
              <span v-else class="muted small-text">Friends</span>
            </div>
          </div>
        </div>
        <div v-if="friendRequests.incoming.length" class="dialog-section">
          <h4>Friend requests <span>{{ friendRequests.incoming.length }}</span></h4>
          <div v-for="request in friendRequests.incoming" :key="request.id" class="friend-row">
            <span class="avatar tiny" :style="avatarStyle(request.user.avatarColor)">{{ initials(request.user.name) }}</span>
            <div class="friend-meta"><strong>{{ request.user.name }}</strong><small>{{ request.user.statusText || request.user.email }}</small></div>
            <div class="row-actions"><button class="primary small" @click="acceptFriendRequest(request)">Accept</button><button class="ghost small" @click="declineFriendRequest(request)">Decline</button></div>
          </div>
        </div>
        <div v-if="friendRequests.outgoing.length" class="dialog-section">
          <h4>Sent requests <span>{{ friendRequests.outgoing.length }}</span></h4>
          <div v-for="request in friendRequests.outgoing" :key="request.id" class="friend-row">
            <span class="avatar tiny" :style="avatarStyle(request.user.avatarColor)">{{ initials(request.user.name) }}</span>
            <div class="friend-meta"><strong>{{ request.user.name }}</strong><small>Waiting for a response</small></div>
            <button class="ghost small" @click="cancelFriendRequest(request)">Cancel</button>
          </div>
        </div>
        <div class="dialog-section">
          <h4>Friends <span>{{ friends.length }} · {{ onlineFriendsCount }} online</span></h4>
          <div v-for="friend in friends" :key="friend.id" class="friend-row">
            <span class="avatar tiny" :style="avatarStyle(friend.avatarColor)">{{ initials(friend.name) }}</span>
            <div class="friend-meta"><strong>{{ friend.name }} <i class="online-dot" :class="{ online: isOnline(friend.id) }"></i></strong><small>{{ friend.statusText || (isOnline(friend.id) ? 'Online now' : 'Offline') }}</small></div>
            <div class="row-actions">
              <button v-if="canInviteToRoom && !selectedRoom.members.includes(friend.id)" class="primary small" @click="inviteFriend(friend)">Invite to room</button>
              <button class="ghost small" @click="unfriend(friend)">Remove</button>
            </div>
          </div>
          <p v-if="!friends.length" class="muted">No friends yet. Search above to send your first request.</p>
        </div>
      </div>
    </div>

    <div v-if="activityDialogOpen" class="dialog-backdrop" @click.self="activityDialogOpen = false" @keydown.esc="activityDialogOpen = false">
      <div class="dialog wide" role="dialog" aria-modal="true">
        <div class="dialog-heading"><div><p class="eyebrow">INBOX</p><h3>Requests and invitations</h3></div><button class="icon-button" @click="activityDialogOpen = false">×</button></div>
        <p v-if="!hasActivity" class="muted">You're all caught up.</p>
        <div v-if="friendRequests.incoming.length" class="dialog-section">
          <h4>Friend requests</h4>
          <div v-for="request in friendRequests.incoming" :key="request.id" class="friend-row">
            <span class="avatar tiny" :style="avatarStyle(request.user.avatarColor)">{{ initials(request.user.name) }}</span>
            <div class="friend-meta"><strong>{{ request.user.name }}</strong><small>{{ request.user.statusText || request.user.email }}</small></div>
            <div class="row-actions"><button class="primary small" @click="acceptFriendRequest(request)">Accept</button><button class="ghost small" @click="declineFriendRequest(request)">Decline</button></div>
          </div>
        </div>
        <div v-if="roomInvitations.length" class="dialog-section">
          <h4>Room invitations</h4>
          <div v-for="invitation in roomInvitations" :key="invitation.id" class="friend-row">
            <div class="friend-meta"><strong>{{ invitation.room.name }}</strong><small>{{ invitation.inviter?.name || 'The creator' }} invited you · {{ invitation.room.visibility === 'invite' ? 'Invite only' : 'Public' }}</small></div>
            <div class="row-actions"><button class="primary small" @click="acceptInvitation(invitation)">Join</button><button class="ghost small" @click="declineInvitation(invitation)">Decline</button></div>
          </div>
        </div>
        <div v-if="ownedJoinRequests.length" class="dialog-section">
          <h4>Join requests for your rooms</h4>
          <div v-for="request in ownedJoinRequests" :key="request.id" class="friend-row">
            <span class="avatar tiny" :style="avatarStyle(request.user.avatarColor)">{{ initials(request.user.name) }}</span>
            <div class="friend-meta"><strong>{{ request.user.name }} → {{ request.room.name }}</strong><small>{{ request.message || 'Asked to join your room' }}</small></div>
            <div class="row-actions"><button class="primary small" @click="respondJoinRequest(request, 'accept')">Accept</button><button class="ghost small" @click="respondJoinRequest(request, 'decline')">Decline</button></div>
          </div>
        </div>
        <div v-if="friendRequests.outgoing.length" class="dialog-section">
          <h4>Sent friend requests</h4>
          <div v-for="request in friendRequests.outgoing" :key="request.id" class="friend-row">
            <span class="avatar tiny" :style="avatarStyle(request.user.avatarColor)">{{ initials(request.user.name) }}</span>
            <div class="friend-meta"><strong>{{ request.user.name }}</strong><small>Waiting for a response</small></div>
            <button class="ghost small" @click="cancelFriendRequest(request)">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="inviteDialogOpen" class="dialog-backdrop" @click.self="inviteDialogOpen = false" @keydown.esc="inviteDialogOpen = false">
      <div class="dialog wide" role="dialog" aria-modal="true">
        <div class="dialog-heading"><div><p class="eyebrow">INVITE ONLY</p><h3>Invite friends to {{ selectedRoom?.name }}</h3></div><button class="icon-button" @click="inviteDialogOpen = false">×</button></div>
        <p class="muted dialog-intro">People you invite can accept from their inbox. Anyone else can ask you to join.</p>
        <div v-for="friend in inviteCandidates" :key="friend.id" class="friend-row">
          <span class="avatar tiny" :style="avatarStyle(friend.avatarColor)">{{ initials(friend.name) }}</span>
          <div class="friend-meta"><strong>{{ friend.name }} <i class="online-dot" :class="{ online: isOnline(friend.id) }"></i></strong><small>{{ friend.statusText || (isOnline(friend.id) ? 'Online now' : 'Offline') }}</small></div>
          <button class="primary small" :disabled="invitedUserIds.includes(friend.id)" @click="inviteFriend(friend)">{{ invitedUserIds.includes(friend.id) ? 'Invited' : 'Invite' }}</button>
        </div>
        <p v-if="!inviteCandidates.length" class="muted">Every friend you have is already in this room, or you haven't added friends yet.</p>
        <div class="dialog-actions"><button class="ghost" @click="inviteDialogOpen = false">Done</button></div>
      </div>
    </div>

    <div class="notifications">
      <div v-for="notification in notifications" :key="notification.id" class="toast">{{ notification.message }}</div>
    </div>
  </main>
</template>
