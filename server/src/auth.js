import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { RefreshToken, User } from './models.js';

const secret = () => process.env.JWT_SECRET || 'development-secret';
const accessTtl = () => process.env.ACCESS_TOKEN_TTL || '15m';
const refreshTtlDays = () => Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);

export const signToken = (user) => jwt.sign({ sub: user._id.toString(), name: user.name, type: 'access' }, secret(), { expiresIn: accessTtl() });

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newRawToken = () => crypto.randomBytes(48).toString('base64url');

export const issueRefreshToken = async (user, family = crypto.randomUUID()) => {
  const token = newRawToken();
  const expiresAt = new Date(Date.now() + refreshTtlDays() * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ user: user._id, tokenHash: hashToken(token), family, expiresAt });
  return { token, family, expiresAt };
};

/**
 * Rotates a refresh token. Every successful use revokes the old token and issues
 * a new one in the same family. Presenting an already-revoked token means it was
 * stolen or replayed, so the entire family is revoked.
 */
export const rotateRefreshToken = async (rawToken) => {
  const stored = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) });
  if (!stored) return { status: 'invalid' };

  if (stored.revokedAt) {
    await RefreshToken.updateMany({ family: stored.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return { status: 'reused' };
  }
  if (stored.expiresAt <= new Date()) return { status: 'expired' };

  // Atomic claim: concurrent refreshes with the same token can only win once.
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: stored._id, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return { status: 'invalid' };

  const user = await User.findById(stored.user).select('_id name email');
  if (!user) return { status: 'invalid' };

  const next = await issueRefreshToken(user, stored.family);
  await RefreshToken.updateOne({ _id: stored._id }, { $set: { replacedByHash: hashToken(next.token) } });
  return { status: 'ok', user, token: next.token };
};

export const revokeRefreshFamily = async (rawToken) => {
  if (!rawToken) return;
  const stored = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) });
  if (stored) await RefreshToken.updateMany({ family: stored.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
};

export const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ message: 'Authentication required' });
    const payload = jwt.verify(header.slice(7), secret());
    if (payload.type !== 'access') throw new Error('Wrong token type');
    const user = await User.findById(payload.sub).select('_id name email');
    if (!user) return res.status(401).json({ message: 'User no longer exists' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

export const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, secret());
    if (payload.type !== 'access') throw new Error('Wrong token type');
    const user = await User.findById(payload.sub).select('_id name email');
    if (!user) return next(new Error('Authentication required'));
    socket.user = user;
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
};
