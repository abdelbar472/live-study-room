import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { authenticate, authenticateSocket, issueRefreshToken, revokeRefreshFamily, rotateRefreshToken, signToken } from './auth.js';
import { Room, User } from './models.js';

const app = express();
const server = http.createServer(app);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const io = new Server(server, { cors: { origin: clientOrigin, credentials: true } });
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json());
app.use(cookieParser());

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

const safeUser = (user) => ({ id: user._id.toString(), name: user.name, email: user.email });
const safeRoom = (room) => ({ id: room._id.toString(), name: room.name, description: room.description, subject: room.subject, owner: room.owner?.toString(), members: room.members?.map(String) || [] });

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name?.trim() || !email?.trim() || !password || password.length < 6) return res.status(400).json({ message: 'Name, email, and a 6+ character password are required' });
    const exists = await User.exists({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ message: 'An account with that email already exists' });
    const user = await User.create({ name: name.trim(), email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12) });
    const refresh = await issueRefreshToken(user);
    res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions());
    res.status(201).json({ token: signToken(user), user: safeUser(user) });
  } catch (error) { res.status(500).json({ message: 'Could not create account', detail: error.message }); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email?.toLowerCase() });
    if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) return res.status(401).json({ message: 'Incorrect email or password' });
    const refresh = await issueRefreshToken(user);
    res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions());
    res.json({ token: signToken(user), user: safeUser(user) });
  } catch (error) { res.status(500).json({ message: 'Could not sign in', detail: error.message }); }
});
app.post('/api/auth/refresh', async (req, res) => {
  try {
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
  } catch (error) { res.status(500).json({ message: 'Could not refresh session', detail: error.message }); }
});
app.post('/api/auth/logout', async (req, res) => {
  try {
    await revokeRefreshFamily(req.cookies?.[REFRESH_COOKIE]);
  } catch (error) { console.error('Could not revoke refresh token:', error.message); }
  clearRefreshCookie(res);
  res.json({ ok: true });
});
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: safeUser(req.user) }));

app.get('/api/rooms', authenticate, async (_, res) => res.json({ rooms: (await Room.find().sort({ createdAt: -1 })).map(safeRoom) }));
app.post('/api/rooms', authenticate, async (req, res) => {
  const room = await Room.create({ name: req.body.name, description: req.body.description, subject: req.body.subject, owner: req.user._id, members: [req.user._id] });
  res.status(201).json({ room: safeRoom(room) });
});
app.post('/api/rooms/:id/join', authenticate, async (req, res) => {
  const room = await Room.findByIdAndUpdate(req.params.id, { $addToSet: { members: req.user._id } }, { new: true });
  if (!room) return res.status(404).json({ message: 'Room not found' });
  res.json({ room: safeRoom(room) });
});

io.use(authenticateSocket);
const roomPresence = new Map();
const broadcastPresence = (roomId) => io.to(roomId).emit('presence:update', [...(roomPresence.get(roomId)?.values() || [])]);
io.on('connection', (socket) => {
  socket.on('room:join', async ({ roomId }) => {
    const room = await Room.findById(roomId);
    if (!room) return socket.emit('room:error', 'Room not found');
    socket.join(roomId);
    if (!roomPresence.has(roomId)) roomPresence.set(roomId, new Map());
    roomPresence.get(roomId).set(socket.id, { id: socket.user._id.toString(), name: socket.user.name, socketId: socket.id });
    socket.data.roomId = roomId;
    broadcastPresence(roomId);
  });
  socket.on('chat:send', ({ roomId, text }) => {
    if (socket.data.roomId !== roomId || !text?.trim()) return;
    io.to(roomId).emit('chat:message', { id: `${socket.id}-${Date.now()}`, text: text.trim().slice(0, 1000), user: { id: socket.user._id.toString(), name: socket.user.name }, createdAt: new Date().toISOString() });
  });
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && roomPresence.has(roomId)) { roomPresence.get(roomId).delete(socket.id); broadcastPresence(roomId); }
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
