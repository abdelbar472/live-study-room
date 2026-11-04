import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 40 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  bio: { type: String, trim: true, maxlength: 240, default: '' },
  statusText: { type: String, trim: true, maxlength: 60, default: '' },
  avatarColor: { type: String, trim: true, default: '#394a39', match: /^#[0-9a-fA-F]{6}$/ }
}, { timestamps: true });

const roomSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 240, default: '' },
  subject: { type: String, trim: true, maxlength: 40, default: 'General' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Public rooms can be joined by anyone. Invite-only rooms require an
  // invitation or an approved join request from the room creator.
  visibility: { type: String, enum: ['public', 'invite'], default: 'public', index: true }
}, { timestamps: true });

const friendshipSchema = new mongoose.Schema({
  // Sorted pair of user ids. A unique pair key means two people can only ever
  // have one friendship document, no matter who sends the request.
  pairKey: { type: String, required: true, unique: true, index: true },
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted'], default: 'pending', index: true }
}, { timestamps: true });

const roomInviteSchema = new mongoose.Schema({
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  inviter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  invitee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending', index: true }
}, { timestamps: true });

roomInviteSchema.index({ room: 1, invitee: 1, status: 1 });

const roomJoinRequestSchema = new mongoose.Schema({
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  message: { type: String, trim: true, maxlength: 200, default: '' },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending', index: true },
  respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

roomJoinRequestSchema.index({ room: 1, user: 1, status: 1 });

const refreshTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Only the SHA-256 hash is stored, so a database leak cannot be replayed.
  tokenHash: { type: String, required: true, unique: true },
  // Tokens from one login chain share a family; reuse revokes the whole family.
  family: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  replacedByHash: { type: String, default: null }
}, { timestamps: true });

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const User = mongoose.model('User', userSchema);
export const Room = mongoose.model('Room', roomSchema);
export const Friendship = mongoose.model('Friendship', friendshipSchema);
export const RoomInvite = mongoose.model('RoomInvite', roomInviteSchema);
export const RoomJoinRequest = mongoose.model('RoomJoinRequest', roomJoinRequestSchema);
export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
