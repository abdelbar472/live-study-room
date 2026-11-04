import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import mongoose from 'mongoose';
import path from 'path';
import { Server } from 'socket.io';
import { authenticate, authenticateSocket, issueRefreshToken, revokeRefreshFamily, rotateRefreshToken, signToken } from './auth.js';
import { Friendship, Room, RoomInvite, RoomJoinRequest, User } from './models.js';

const app = express();
const server = http.createServer(app);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const io = new Server(server, { cors: { origin: clientOrigin, credentials: true } });
const USER_FIELDS = 'name email bio statusText avatarColor';
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || 'uploads');
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['application/zip', '.zip'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['video/mp4', '.mp4']
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: clientOrigin, credentials: true }));
// Attachments travel as base64 data URLs so the API does not need a multipart
// dependency. 5 MB of file becomes ~6.7 MB of JSON.
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
// Uploaded files are stored under random names. Images render inline; anything
// else is forced to download so an uploaded document cannot execute as a page.
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '7d',
  immutable: true,
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

const REFRESH_COOKIE = 'refreshToken';
const refreshTtlDays = () => Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
const secureCookies = () => {
  const override = process.env.COOKIE_SECURE;
  // An explicit COOKIE_SECURE (set by docker-compose) must win over NODE_ENV,
  // otherwise production mode would force Secure cookies on plain HTTP and the
  // browser would silently stop sending the refresh token.
  if (override !== undefined && override !== '') return override === 'true';
  return process.env.NODE_ENV === 'production';
};
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: secureCookies(),
  sameSite: process.env.COOKIE_SAME_SITE || 'lax',
  path: '/api/auth',
  maxAge: refreshTtlDays() * 24 * 60 * 60 * 1000
});
const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, {
  httpOnly: true,
  secure: secureCookies(),
  sameSite: process.env.COOKIE_SAME_SITE || 'lax',
  path: '/api/auth'
});

const asyncRoute = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ message: 'Something went wrong', detail: error.message });
  }
};
const safeUser = (user) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  bio: user.bio || '',
  statusText: user.statusText || '',
  avatarColor: user.avatarColor || '#394a39'
});
const roomOwnerId = (room) => (room.owner?._id || room.owner)?.toString();
const roomMemberIds = (room) => room.members?.map((member) => member.toString()) || [];
const isRoomMember = (room, userId) => roomMemberIds(room).includes(userId.toString());
const safeRoom = (room, viewerId, extras = {}) => {
  const viewer = viewerId?.toString();
  const owner = roomOwnerId(room);
  return {
    id: room._id.toString(),
    name: room.name,
    description: room.description,
    subject: room.subject,
    owner,
    ownerName: room.owner?.name || null,
    members: roomMemberIds(room),
    visibility: room.visibility || 'public',
    createdAt: room.createdAt,
    isOwner: owner === viewer,
    isMember: roomMemberIds(room).includes(viewer),
    ...extras
  };
};
const friendPairKey = (a, b) => [a.toString(), b.toString()].sort().join(':');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validObjectId = (value) => mongoose.isValidObjectId(value);
const cleanMessage = (value, max = 1000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// ---------------------------------------------------------------------------
// Live presence (global online users + per-room participants)
// ---------------------------------------------------------------------------
const onlineSockets = new Map(); // userId -> Set<socketId>
const onlineUserIds = () => [...onlineSockets.keys()];
const isOnline = (userId) => onlineSockets.has(userId.toString());
const userRoom = (userId) => `user:${userId.toString()}`;
const emitToUser = (userId, event, payload) => io.to(userRoom(userId)).emit(event, payload);
const broadcastOnline = () => io.emit('presence:online', { userIds: onlineUserIds(), count: onlineSockets.size });
const notifyUser = (userId, message, type = 'info') => emitToUser(userId, 'notification', {
  id: crypto.randomUUID(),
  type,
  message,
  createdAt: new Date().toISOString()
});

const roomPresence = new Map(); // roomId -> Map<socketId, person>
const broadcastPresence = (roomId) => io.to(roomId).emit('presence:update', [...(roomPresence.get(roomId)?.values() || [])]);
const leaveRoomPresence = (socket, roomId) => {
  if (!roomId || !roomPresence.has(roomId)) return;
  roomPresence.get(roomId).delete(socket.id);
  if (!roomPresence.get(roomId).size) roomPresence.delete(roomId);
  else broadcastPresence(roomId);
};
const presenceFor = (socket) => ({
  id: socket.user._id.toString(),
  name: socket.user.name,
  avatarColor: socket.user.avatarColor || '#394a39',
  statusText: socket.user.statusText || '',
  socketId: socket.id
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) return res.status(400).json({ message: 'Name, email, and a 6+ character password are required' });
  const exists = await User.exists({ email: email.toLowerCase() });
  if (exists) return res.status(409).json({ message: 'An account with that email already exists' });
  const user = await User.create({ name: name.trim(), email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12) });
  const refresh = await issueRefreshToken(user);
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions());
  res.status(201).json({ token: signToken(user), user: safeUser(user) });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const user = await User.findOne({ email: req.body.email?.toLowerCase() });
  if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) return res.status(401).json({ message: 'Incorrect email or password' });
  const refresh = await issueRefreshToken(user);
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions());
  res.json({ token: signToken(user), user: safeUser(user) });
}));
app.post('/api/auth/refresh', asyncRoute(async (req, res) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE];
  if (!rawToken) return res.status(401).json({ message: 'No refresh token' });
  const result = await rotateRefreshToken(rawToken);
  if (result.status !== 'ok') {
    clearRefreshCookie(res);
    const message = result.status === 'reused'
      ? 'Refresh token reuse detected; all sessions in this chain were revoked'
      : 'Invalid or expired refresh token';
    return res.status(401).json({ message });
  }
  res.cookie(REFRESH_COOKIE, result.token, refreshCookieOptions());
  res.json({ token: signToken(result.user), user: safeUser(result.user) });
}));
app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  try {
    await revokeRefreshFamily(req.cookies?.[REFRESH_COOKIE]);
  } catch (error) { console.error('Could not revoke refresh token:', error.message); }
  clearRefreshCookie(res);
  res.json({ ok: true });
}));
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: safeUser(req.user) }));

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
app.patch('/api/users/me', authenticate, asyncRoute(async (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) {
    const name = cleanMessage(req.body.name, 41);
    if (!name || name.length > 40) return res.status(400).json({ message: 'Name must be 1–40 characters' });
    updates.name = name;
  }
  if (req.body.bio !== undefined) {
    const bio = cleanMessage(req.body.bio, 241);
    if (bio.length > 240) return res.status(400).json({ message: 'Bio must be 240 characters or fewer' });
    updates.bio = bio;
  }
  if (req.body.statusText !== undefined) {
    const statusText = cleanMessage(req.body.statusText, 61);
    if (statusText.length > 60) return res.status(400).json({ message: 'Status must be 60 characters or fewer' });
    updates.statusText = statusText;
  }
  if (req.body.avatarColor !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(req.body.avatarColor)) return res.status(400).json({ message: 'Avatar color must be a hex color like #394a39' });
    updates.avatarColor = req.body.avatarColor.toLowerCase();
  }
  const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true, runValidators: true }).select(USER_FIELDS);
  if (!user) return res.status(404).json({ message: 'User not found' });

  // Keep already-connected room presence cards in sync without a reconnect.
  for (const [roomId, people] of roomPresence) {
    let changed = false;
    for (const [socketId, person] of people) {
      if (person.id === user._id.toString()) {
        people.set(socketId, { ...person, name: user.name, avatarColor: user.avatarColor, statusText: user.statusText });
        changed = true;
      }
    }
    if (changed) broadcastPresence(roomId);
  }
  res.json({ user: safeUser(user) });
}));
app.get('/api/users/me', authenticate, (req, res) => res.json({
  user: { ...safeUser(req.user), relationship: 'self', online: isOnline(req.user._id) }
}));
app.get('/api/users/search', authenticate, asyncRoute(async (req, res) => {
  const query = cleanMessage(req.query.q, 80);
  if (query.length < 2) return res.json({ users: [] });
  const regex = new RegExp(escapeRegex(query), 'i');
  const users = await User.find({ _id: { $ne: req.user._id }, $or: [{ name: regex }, { email: regex }] })
    .select(USER_FIELDS)
    .limit(12);
  const viewer = req.user._id.toString();
  const links = await Friendship.find({ pairKey: { $in: users.map((user) => friendPairKey(viewer, user._id)) } });
  const byPair = new Map(links.map((link) => [link.pairKey, link]));
  res.json({
    users: users.map((user) => {
      const link = byPair.get(friendPairKey(viewer, user._id));
      let relationship = 'none';
      if (link?.status === 'accepted') relationship = 'friend';
      else if (link) relationship = link.requester.toString() === viewer ? 'outgoing' : 'incoming';
      return { ...safeUser(user), relationship, online: isOnline(user._id) };
    })
  });
}));
app.get('/api/users/:id', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'User not found' });
  const user = await User.findById(req.params.id).select(USER_FIELDS);
  if (!user) return res.status(404).json({ message: 'User not found' });
  let relationship = user._id.toString() === req.user._id.toString() ? 'self' : 'none';
  if (relationship === 'none') {
    const link = await Friendship.findOne({ pairKey: friendPairKey(req.user._id, user._id) });
    if (link?.status === 'accepted') relationship = 'friend';
    else if (link) relationship = link.requester.toString() === req.user._id.toString() ? 'outgoing' : 'incoming';
  }
  res.json({ user: { ...safeUser(user), relationship, online: isOnline(user._id) } });
}));

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------
app.get('/api/friends', authenticate, asyncRoute(async (req, res) => {
  const userId = req.user._id;
  const links = await Friendship.find({ status: 'accepted', $or: [{ requester: userId }, { recipient: userId }] })
    .populate('requester', USER_FIELDS)
    .populate('recipient', USER_FIELDS);
  const friends = links
    .map((link) => {
      const other = link.requester?._id?.equals(userId) ? link.recipient : link.requester;
      if (!other) return null;
      return { ...safeUser(other), friendshipId: link._id.toString(), online: isOnline(other._id) };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  res.json({ friends });
}));
app.get('/api/friends/requests', authenticate, asyncRoute(async (req, res) => {
  const userId = req.user._id;
  const [incoming, outgoing] = await Promise.all([
    Friendship.find({ recipient: userId, status: 'pending' }).populate('requester', USER_FIELDS).sort({ createdAt: -1 }),
    Friendship.find({ requester: userId, status: 'pending' }).populate('recipient', USER_FIELDS).sort({ createdAt: -1 })
  ]);
  const serialize = (link, person) => person ? { id: link._id.toString(), user: safeUser(person), createdAt: link.createdAt } : null;
  res.json({
    incoming: incoming.map((link) => serialize(link, link.requester)).filter(Boolean),
    outgoing: outgoing.map((link) => serialize(link, link.recipient)).filter(Boolean)
  });
}));
app.post('/api/friends/requests', authenticate, asyncRoute(async (req, res) => {
  const { userId } = req.body;
  if (!validObjectId(userId)) return res.status(400).json({ message: 'Choose a valid user' });
  if (userId.toString() === req.user._id.toString()) return res.status(400).json({ message: 'You cannot add yourself' });
  const target = await User.findById(userId).select(USER_FIELDS);
  if (!target) return res.status(404).json({ message: 'User not found' });

  const pairKey = friendPairKey(req.user._id, target._id);
  const existing = await Friendship.findOne({ pairKey });
  if (existing?.status === 'accepted') return res.status(409).json({ message: 'You are already friends' });
  if (existing) {
    const message = existing.requester.toString() === req.user._id.toString()
      ? 'You already sent this person a friend request'
      : 'They already sent you a friend request. Accept it instead.';
    return res.status(409).json({ message });
  }

  const request = await Friendship.create({ pairKey, requester: req.user._id, recipient: target._id, status: 'pending' });
  emitToUser(target._id, 'friends:updated');
  notifyUser(target._id, `${req.user.name} sent you a friend request`, 'friend');
  res.status(201).json({ request: { id: request._id.toString(), user: safeUser(target), createdAt: request.createdAt } });
}));
app.post('/api/friends/requests/:id/accept', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Friend request not found' });
  const request = await Friendship.findOne({ _id: req.params.id, recipient: req.user._id, status: 'pending' }).populate('requester', USER_FIELDS);
  if (!request) return res.status(404).json({ message: 'Friend request not found' });
  request.status = 'accepted';
  await request.save();
  emitToUser(request.requester._id, 'friends:updated');
  emitToUser(req.user._id, 'friends:updated');
  notifyUser(request.requester._id, `${req.user.name} accepted your friend request`, 'friend');
  res.json({ friend: { ...safeUser(request.requester), friendshipId: request._id.toString(), online: isOnline(request.requester._id) } });
}));
app.post('/api/friends/requests/:id/decline', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Friend request not found' });
  const request = await Friendship.findOneAndDelete({ _id: req.params.id, recipient: req.user._id, status: 'pending' });
  if (!request) return res.status(404).json({ message: 'Friend request not found' });
  emitToUser(request.requester, 'friends:updated');
  emitToUser(req.user._id, 'friends:updated');
  res.json({ ok: true });
}));
app.delete('/api/friends/requests/:id', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Friend request not found' });
  const request = await Friendship.findOneAndDelete({ _id: req.params.id, requester: req.user._id, status: 'pending' });
  if (!request) return res.status(404).json({ message: 'Friend request not found' });
  emitToUser(request.recipient, 'friends:updated');
  emitToUser(req.user._id, 'friends:updated');
  res.json({ ok: true });
}));
app.delete('/api/friends/:userId', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.userId)) return res.status(404).json({ message: 'Friend not found' });
  const link = await Friendship.findOneAndDelete({ pairKey: friendPairKey(req.user._id, req.params.userId), status: 'accepted' });
  if (!link) return res.status(404).json({ message: 'Friend not found' });
  emitToUser(req.params.userId, 'friends:updated');
  emitToUser(req.user._id, 'friends:updated');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Rooms, invitations, and join requests
// ---------------------------------------------------------------------------
const roomSummary = (room) => ({ id: room._id.toString(), name: room.name, visibility: room.visibility || 'public' });
const joinRequestPayload = (request) => ({
  id: request._id.toString(),
  message: request.message || '',
  status: request.status,
  user: request.user ? safeUser(request.user) : undefined,
  room: request.room?._id ? roomSummary(request.room) : undefined,
  createdAt: request.createdAt
});
const invitationPayload = (invite, viewer) => ({
  id: invite._id.toString(),
  room: invite.room?._id ? safeRoom(invite.room, viewer, { invited: true }) : null,
  inviter: invite.inviter ? safeUser(invite.inviter) : null,
  status: invite.status,
  createdAt: invite.createdAt
});

app.get('/api/rooms', authenticate, asyncRoute(async (req, res) => {
  const viewer = req.user._id;
  const rooms = await Room.find().sort({ createdAt: -1 }).populate('owner', 'name');
  const roomIds = rooms.map((room) => room._id);
  const ownedRoomIds = rooms.filter((room) => roomOwnerId(room) === viewer.toString()).map((room) => room._id);
  const [myRequests, myInvites, ownedCounts] = await Promise.all([
    RoomJoinRequest.find({ user: viewer, room: { $in: roomIds } }).sort({ createdAt: -1 }).select('room status'),
    RoomInvite.find({ invitee: viewer, status: 'pending', room: { $in: roomIds } }).select('room'),
    RoomJoinRequest.aggregate([
      { $match: { room: { $in: ownedRoomIds }, status: 'pending' } },
      { $group: { _id: '$room', count: { $sum: 1 } } }
    ])
  ]);
  const requestStatus = new Map();
  for (const request of myRequests) {
    const key = request.room.toString();
    if (!requestStatus.has(key)) requestStatus.set(key, request.status);
  }
  const invitedRooms = new Set(myInvites.map((invite) => invite.room.toString()));
  const pendingCounts = new Map(ownedCounts.map((entry) => [entry._id.toString(), entry.count]));

  res.json({
    rooms: rooms.map((room) => safeRoom(room, viewer, {
      myRequestStatus: requestStatus.get(room._id.toString()) || null,
      invited: invitedRooms.has(room._id.toString()),
      pendingRequests: pendingCounts.get(room._id.toString()) || 0
    }))
  });
}));
app.post('/api/rooms', authenticate, asyncRoute(async (req, res) => {
  if (!req.body.name?.trim()) return res.status(400).json({ message: 'Room name is required' });
  const room = await Room.create({
    name: cleanMessage(req.body.name, 80),
    description: cleanMessage(req.body.description, 240),
    subject: cleanMessage(req.body.subject, 40) || 'General',
    visibility: req.body.visibility === 'invite' ? 'invite' : 'public',
    owner: req.user._id,
    members: [req.user._id]
  });
  res.status(201).json({ room: safeRoom(room, req.user._id, { pendingRequests: 0 }) });
}));
app.get('/api/rooms/invitations', authenticate, asyncRoute(async (req, res) => {
  const invites = await RoomInvite.find({ invitee: req.user._id, status: 'pending' })
    .populate({ path: 'room', populate: { path: 'owner', select: 'name' } })
    .populate('inviter', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ invitations: invites.filter((invite) => invite.room).map((invite) => invitationPayload(invite, req.user._id)) });
}));
app.get('/api/rooms/join-requests', authenticate, asyncRoute(async (req, res) => {
  const owned = await Room.find({ owner: req.user._id }).select('_id');
  const requests = await RoomJoinRequest.find({ room: { $in: owned.map((room) => room._id) }, status: 'pending' })
    .populate('user', USER_FIELDS)
    .populate('room', 'name visibility')
    .sort({ createdAt: 1 });
  res.json({ requests: requests.filter((request) => request.user && request.room).map(joinRequestPayload) });
}));
app.get('/api/rooms/:id', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Room not found' });
  const room = await Room.findById(req.params.id).populate('owner', 'name');
  if (!room) return res.status(404).json({ message: 'Room not found' });
  const [invite, request] = await Promise.all([
    RoomInvite.findOne({ room: room._id, invitee: req.user._id, status: 'pending' }).select('_id'),
    RoomJoinRequest.findOne({ room: room._id, user: req.user._id }).sort({ createdAt: -1 }).select('status')
  ]);
  res.json({
    room: safeRoom(room, req.user._id, {
      invited: Boolean(invite),
      myRequestStatus: request?.status || null
    })
  });
}));
app.post('/api/rooms/:id/join', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Room not found' });
  const room = await Room.findById(req.params.id).populate('owner', 'name');
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (!isRoomMember(room, req.user._id)) {
    if ((room.visibility || 'public') === 'invite') {
      const invite = await RoomInvite.findOne({ room: room._id, invitee: req.user._id, status: 'pending' });
      if (!invite) return res.status(403).json({ message: 'This room is invite-only. Ask the room creator to let you in.' });
      invite.status = 'accepted';
      await invite.save();
    }
    room.members.addToSet(req.user._id);
    await room.save();
    await RoomJoinRequest.updateMany(
      { room: room._id, user: req.user._id, status: 'pending' },
      { $set: { status: 'accepted', respondedBy: room.owner?._id || room.owner } }
    );
    await RoomInvite.updateMany({ room: room._id, invitee: req.user._id, status: 'pending' }, { $set: { status: 'accepted' } });
    if (roomOwnerId(room) !== req.user._id.toString()) {
      emitToUser(roomOwnerId(room), 'rooms:updated');
      notifyUser(roomOwnerId(room), `${req.user.name} joined ${room.name}`, 'room');
    }
    io.to(room._id.toString()).emit('room:members:updated');
  }
  res.json({ room: safeRoom(room, req.user._id, { pendingRequests: 0 }) });
}));
app.post('/api/rooms/:id/invitations', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Room not found' });
  if (!validObjectId(req.body.userId)) return res.status(400).json({ message: 'Choose a valid user' });
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (roomOwnerId(room) !== req.user._id.toString()) return res.status(403).json({ message: 'Only the room creator can invite people' });
  if (isRoomMember(room, req.body.userId)) return res.status(409).json({ message: 'That person is already in the room' });
  if (req.body.userId.toString() === req.user._id.toString()) return res.status(400).json({ message: 'You are already the room creator' });
  const invitee = await User.findById(req.body.userId).select(USER_FIELDS);
  if (!invitee) return res.status(404).json({ message: 'User not found' });

  const invite = await RoomInvite.findOneAndUpdate(
    { room: room._id, invitee: invitee._id, status: 'pending' },
    { $set: { inviter: req.user._id }, $setOnInsert: { room: room._id, invitee: invitee._id, status: 'pending' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  // A pending join request stays pending until the invitee accepts, so the
  // owner can still see and decline it independently.
  emitToUser(invitee._id, 'room:invitations:updated');
  notifyUser(invitee._id, `${req.user.name} invited you to ${room.name}`, 'room');
  res.status(201).json({
    invitation: invitationPayload({ ...invite.toObject(), room, inviter: req.user }, invitee._id)
  });
}));
app.post('/api/rooms/invitations/:id/accept', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Invitation not found' });
  const invite = await RoomInvite.findOne({ _id: req.params.id, invitee: req.user._id, status: 'pending' })
    .populate({ path: 'room', populate: { path: 'owner', select: 'name' } });
  if (!invite || !invite.room) return res.status(404).json({ message: 'Invitation not found' });
  invite.status = 'accepted';
  await invite.save();
  invite.room.members.addToSet(req.user._id);
  await invite.room.save();
  await RoomJoinRequest.updateMany(
    { room: invite.room._id, user: req.user._id, status: 'pending' },
    { $set: { status: 'accepted', respondedBy: req.user._id } }
  );
  const ownerId = roomOwnerId(invite.room);
  emitToUser(ownerId, 'rooms:updated');
  emitToUser(req.user._id, 'rooms:updated');
  notifyUser(ownerId, `${req.user.name} accepted your invitation to ${invite.room.name}`, 'room');
  res.json({ room: safeRoom(invite.room, req.user._id) });
}));
app.post('/api/rooms/invitations/:id/decline', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Invitation not found' });
  const invite = await RoomInvite.findOneAndUpdate(
    { _id: req.params.id, invitee: req.user._id, status: 'pending' },
    { $set: { status: 'declined' } },
    { new: true }
  );
  if (!invite) return res.status(404).json({ message: 'Invitation not found' });
  emitToUser(req.user._id, 'room:invitations:updated');
  res.json({ ok: true });
}));
app.post('/api/rooms/:id/join-requests', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Room not found' });
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (isRoomMember(room, req.user._id)) return res.status(409).json({ message: 'You are already in this room' });
  if ((room.visibility || 'public') === 'public') return res.status(400).json({ message: 'This room is open to everyone. Join it directly.' });
  const invite = await RoomInvite.findOne({ room: room._id, invitee: req.user._id, status: 'pending' });
  if (invite) return res.status(409).json({ message: 'You already have an invitation to this room' });
  const existing = await RoomJoinRequest.findOne({ room: room._id, user: req.user._id, status: 'pending' });
  if (existing) return res.json({ request: joinRequestPayload(existing) });

  const request = await RoomJoinRequest.create({
    room: room._id,
    user: req.user._id,
    message: cleanMessage(req.body.message, 200),
    status: 'pending'
  });
  const ownerId = roomOwnerId(room);
  emitToUser(ownerId, 'room:requests:updated');
  notifyUser(ownerId, `${req.user.name} asked to join ${room.name}`, 'room');
  res.status(201).json({ request: joinRequestPayload({ ...request.toObject(), user: req.user, room }) });
}));
app.get('/api/rooms/:id/join-requests', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Room not found' });
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (roomOwnerId(room) !== req.user._id.toString()) return res.status(403).json({ message: 'Only the room creator can see join requests' });
  const requests = await RoomJoinRequest.find({ room: room._id, status: 'pending' })
    .populate('user', USER_FIELDS)
    .sort({ createdAt: 1 });
  res.json({ requests: requests.filter((request) => request.user).map((request) => joinRequestPayload({ ...request.toObject(), user: request.user, room })) });
}));
app.post('/api/rooms/:id/join-requests/:requestId/accept', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id) || !validObjectId(req.params.requestId)) return res.status(404).json({ message: 'Join request not found' });
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (roomOwnerId(room) !== req.user._id.toString()) return res.status(403).json({ message: 'Only the room creator can approve join requests' });
  const request = await RoomJoinRequest.findOne({ _id: req.params.requestId, room: room._id, status: 'pending' });
  if (!request) return res.status(404).json({ message: 'Join request not found' });

  request.status = 'accepted';
  request.respondedBy = req.user._id;
  await request.save();
  room.members.addToSet(request.user);
  await room.save();
  await RoomInvite.updateMany({ room: room._id, invitee: request.user, status: 'pending' }, { $set: { status: 'accepted' } });
  emitToUser(request.user, 'rooms:updated');
  notifyUser(request.user, `Your request to join ${room.name} was approved`, 'room');
  emitToUser(req.user._id, 'room:requests:updated');
  res.json({ request: { id: request._id.toString(), status: request.status }, room: safeRoom(room, req.user._id) });
}));
app.post('/api/rooms/:id/join-requests/:requestId/decline', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id) || !validObjectId(req.params.requestId)) return res.status(404).json({ message: 'Join request not found' });
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (roomOwnerId(room) !== req.user._id.toString()) return res.status(403).json({ message: 'Only the room creator can decline join requests' });
  const request = await RoomJoinRequest.findOneAndUpdate(
    { _id: req.params.requestId, room: room._id, status: 'pending' },
    { $set: { status: 'declined', respondedBy: req.user._id } },
    { new: true }
  );
  if (!request) return res.status(404).json({ message: 'Join request not found' });
  emitToUser(request.user, 'rooms:updated');
  notifyUser(request.user, `Your request to join ${room.name} was declined`, 'room');
  emitToUser(req.user._id, 'room:requests:updated');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Chat attachments (base64 upload, then the URL is sent over Socket.IO)
// ---------------------------------------------------------------------------
app.post('/api/rooms/:id/attachments', authenticate, asyncRoute(async (req, res) => {
  if (!validObjectId(req.params.id)) return res.status(404).json({ message: 'Room not found' });
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (!isRoomMember(room, req.user._id)) return res.status(403).json({ message: 'You must be in the room to send attachments' });

  const data = typeof req.body.data === 'string' ? req.body.data : '';
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(data);
  if (!match) return res.status(400).json({ message: 'Attachment must be a base64 data URL' });
  const mime = match[1].toLowerCase();
  const extension = ATTACHMENT_EXTENSIONS.get(mime);
  if (!extension) return res.status(415).json({ message: 'That file type is not supported' });
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) return res.status(400).json({ message: 'The attachment is empty' });
  if (buffer.length > MAX_ATTACHMENT_BYTES) return res.status(413).json({ message: 'Attachments must be 5 MB or smaller' });

  const fileName = `${crypto.randomUUID()}${extension}`;
  const roomDir = path.join(uploadsDir, room._id.toString());
  await fs.promises.mkdir(roomDir, { recursive: true });
  await fs.promises.writeFile(path.join(roomDir, fileName), buffer);

  const displayName = cleanMessage(req.body.name, 120).replace(/[\r\n]/g, ' ') || `attachment${extension}`;
  res.status(201).json({
    attachment: {
      name: displayName,
      type: mime,
      size: buffer.length,
      url: `/uploads/${room._id}/${fileName}`
    }
  });
}));

// ---------------------------------------------------------------------------
// Socket.IO: room presence, chat, and live notifications
// ---------------------------------------------------------------------------
io.use(authenticateSocket);
io.on('connection', (socket) => {
  const userId = socket.user._id.toString();
  socket.join(userRoom(userId));
  if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
  onlineSockets.get(userId).add(socket.id);
  broadcastOnline();

  socket.on('room:join', async ({ roomId } = {}) => {
    if (!validObjectId(roomId)) return socket.emit('room:error', 'Room not found');
    try {
      const room = await Room.findById(roomId);
      if (!room) return socket.emit('room:error', 'Room not found');
      if (!isRoomMember(room, socket.user._id)) return socket.emit('room:error', 'You are not a member of this room');

      if (socket.data.roomId && socket.data.roomId !== roomId) {
        socket.leave(socket.data.roomId);
        leaveRoomPresence(socket, socket.data.roomId);
      }
      socket.join(roomId);
      if (!roomPresence.has(roomId)) roomPresence.set(roomId, new Map());
      roomPresence.get(roomId).set(socket.id, presenceFor(socket));
      socket.data.roomId = roomId;
      broadcastPresence(roomId);
    } catch (error) {
      socket.emit('room:error', 'Could not join the room');
    }
  });
  socket.on('room:leave', ({ roomId } = {}) => {
    if (!roomId || socket.data.roomId !== roomId) return;
    socket.leave(roomId);
    leaveRoomPresence(socket, roomId);
    socket.data.roomId = null;
  });
  socket.on('chat:send', ({ roomId, text, attachment } = {}) => {
    if (socket.data.roomId !== roomId) return;
    const messageText = cleanMessage(text, 1000);
    const attachmentPrefix = `/uploads/${roomId}/`;
    const attachmentName = typeof attachment?.url === 'string' && attachment.url.startsWith(attachmentPrefix)
      ? attachment.url.slice(attachmentPrefix.length)
      : '';
    const safeAttachment = /^[a-z0-9-]+\.[a-z0-9]+$/i.test(attachmentName)
      ? {
          name: cleanMessage(attachment.name, 120) || 'attachment',
          type: cleanMessage(attachment.type, 100) || 'application/octet-stream',
          size: Math.max(0, Number(attachment.size) || 0),
          url: attachment.url
        }
      : null;
    if (!messageText && !safeAttachment) return;
    io.to(roomId).emit('chat:message', {
      id: `${socket.id}-${Date.now()}`,
      text: messageText,
      attachment: safeAttachment,
      user: {
        id: userId,
        name: socket.user.name,
        avatarColor: socket.user.avatarColor || '#394a39'
      },
      createdAt: new Date().toISOString()
    });
  });
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.leave(roomId);
      leaveRoomPresence(socket, roomId);
    }
    const sockets = onlineSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (!sockets.size) onlineSockets.delete(userId);
    }
    broadcastOnline();
  });
});

const port = Number(process.env.PORT || 3000);
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/live-study-room')
  .then(() => server.listen(port, () => console.log(`API listening on http://localhost:${port}`)))
  .catch((error) => { console.error('MongoDB connection failed:', error.message); process.exit(1); });

// Containers send SIGTERM on stop and redeploy. Close sockets and the database
// cleanly instead of waiting for Docker to SIGKILL after the grace period.
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  io.close();
  server.close(async () => {
    try { await mongoose.connection.close(); } finally { process.exit(0); }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
