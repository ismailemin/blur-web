// Wire contract for the WebRTC data-channel transport adapter.
//
// This module is an original project protocol. It does not carry game assets,
// does not describe a retail Blur protocol and does not replace the net-mvp
// room protocol. It adds one thing to it: a signaling message set that the room
// service must relay between two players of the same room, and a rule that maps
// the existing data-plane messages (input/state/ack/resync/final) onto a pair
// of WebRTC DataChannels.
//
// Channel choice is a fixed policy, not a runtime guess:
//
//   'event'    reliable, ordered     -> input, ack, resync, stream.final,
//                                       stream.error
//   'snapshot' unreliable, unordered -> state
//
// The room/lobby/selection/start/finish messages never use a DataChannel; they
// stay on the room service WebSocket. That keeps room state authoritative in one
// place and means a DataChannel failure never costs the session.

import { NetError, isObject, isInteger, validChannel, validSeq, validTick } from '../net-mvp/protocol.mjs';

export const SIGNAL_SCHEMA = 'blur.net-webrtc.signal/1';
export const SIGNAL_VERSION = 1;
export const SIGNAL_PROTOCOL = 1;

export const TRANSPORT_MODES = Object.freeze(['auto', 'webrtc', 'ws']);
export const TRANSPORT_WIRE = Object.freeze(['ws', 'webrtc', 'ws-fallback']);

// Negotiated channels. Both peers create both channels with the same fixed id;
// `negotiated:true` removes the in-band establishment race. Labels are local
// metadata only and never appear inside a payload.
export const CHANNEL_EVENT = 'event';
export const CHANNEL_SNAPSHOT = 'snapshot';
export const CHANNEL_LABELS = Object.freeze({
  [CHANNEL_EVENT]: 'blur/rel/1',
  [CHANNEL_SNAPSHOT]: 'blur/unrel/1'
});
export const CHANNEL_IDS = Object.freeze({
  [CHANNEL_EVENT]: 0,
  [CHANNEL_SNAPSHOT]: 1
});
export const CHANNEL_OPTIONS = Object.freeze({
  [CHANNEL_EVENT]: Object.freeze({ negotiated: true, id: 0, ordered: true }),
  [CHANNEL_SNAPSHOT]: Object.freeze({ negotiated: true, id: 1, ordered: false, maxRetransmits: 0 })
});

// Data-plane message types and the channel they must use. Everything else
// (room.*, player.*, client.finished, ping, error, welcome, signal.*) is a room
// service message and must stay on the WebSocket.
export const DATA_PLANE_TYPES = Object.freeze({
  state: CHANNEL_SNAPSHOT,
  input: CHANNEL_EVENT,
  ack: CHANNEL_EVENT,
  resync: CHANNEL_EVENT,
  'stream.final': CHANNEL_EVENT,
  'stream.error': CHANNEL_EVENT
});

export const SIGNAL_TYPES = Object.freeze([
  'signal.offer', 'signal.answer', 'signal.ice', 'signal.bye'
]);

export const DATA_MESSAGE_TYPES = Object.freeze(Object.keys(DATA_PLANE_TYPES));

export const WEBRTC_ERROR_CODES = Object.freeze({
  WEBRTC_UNSUPPORTED: 'WEBRTC_UNSUPPORTED',
  WEBRTC_CONFIG: 'WEBRTC_CONFIG',
  WEBRTC_DISABLED: 'WEBRTC_DISABLED',
  WEBRTC_SIGNAL_INVALID: 'WEBRTC_SIGNAL_INVALID',
  WEBRTC_SIGNAL_UNKNOWN_PEER: 'WEBRTC_SIGNAL_UNKNOWN_PEER',
  WEBRTC_SIGNAL_TIMEOUT: 'WEBRTC_SIGNAL_TIMEOUT',
  WEBRTC_ICE_TIMEOUT: 'WEBRTC_ICE_TIMEOUT',
  WEBRTC_ICE_FAILED: 'WEBRTC_ICE_FAILED',
  WEBRTC_ICE_DISCONNECTED: 'WEBRTC_ICE_DISCONNECTED',
  WEBRTC_ICE_RESTART_FAILED: 'WEBRTC_ICE_RESTART_FAILED',
  WEBRTC_DATACHANNEL_FAILED: 'WEBRTC_DATACHANNEL_FAILED',
  WEBRTC_DATACHANNEL_CLOSED: 'WEBRTC_DATACHANNEL_CLOSED',
  WEBRTC_SEND_FAILED: 'WEBRTC_SEND_FAILED',
  WEBRTC_BUFFER_FULL: 'WEBRTC_BUFFER_FULL',
  WEBRTC_MESSAGE_INVALID: 'WEBRTC_MESSAGE_INVALID',
  WEBRTC_PEER_LEFT: 'WEBRTC_PEER_LEFT',
  WEBRTC_OFFER_REJECTED: 'WEBRTC_OFFER_REJECTED',
  WEBRTC_FALLBACK_WS: 'WEBRTC_FALLBACK_WS'
});

export class WebRtcError extends NetError {
  constructor(code, message, detail = null) {
    super(WEBRTC_ERROR_CODES[code] ? code : WEBRTC_ERROR_CODES.WEBRTC_CONFIG, message, detail);
    this.name = 'WebRtcError';
    this.transport = 'webrtc';
  }
}

export function rejectTransportMode(mode) {
  if (!TRANSPORT_MODES.includes(mode)) {
    throw new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_CONFIG,
      'transport must be one of ' + TRANSPORT_MODES.join(', '), { transport: mode ?? null });
  }
  return mode;
}

export function validSignalType(type) {
  return SIGNAL_TYPES.includes(type);
}

export function validEpoch(value) {
  return isInteger(value) && value >= 0 && value <= 1_000_000;
}

export function validSdp(description) {
  if (!isObject(description)) return false;
  if (description.type !== 'offer' && description.type !== 'answer') return false;
  return typeof description.sdp === 'string' && description.sdp.length > 0 && description.sdp.length <= 64 * 1024;
}

/** RTCIceCandidateInit or null (end-of-candidates). */
export function validCandidate(candidate) {
  if (candidate === null || candidate === undefined) return true;
  if (!isObject(candidate)) return false;
  if (candidate.candidate !== undefined && typeof candidate.candidate !== 'string') return false;
  if (candidate.sdpMid !== undefined && candidate.sdpMid !== null && typeof candidate.sdpMid !== 'string') return false;
  if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null &&
      (!isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0 || candidate.sdpMLineIndex > 1024)) return false;
  if (candidate.usernameFragment !== undefined && candidate.usernameFragment !== null &&
      typeof candidate.usernameFragment !== 'string') return false;
  if (typeof candidate.candidate === 'string' && candidate.candidate.length > 4096) return false;
  return true;
}

/**
 * Validate an inbound signaling message after the room service has added
 * `from`. Returns an error string or null; never throws for data.
 */
export function checkSignal(message, selfId = null) {
  if (!isObject(message)) return 'signal must be an object';
  if (!validSignalType(message.type)) return 'unknown signal type';
  if (typeof message.to !== 'string' || !/^pl_[0-9a-f]{16}$/.test(message.to)) return 'signal.to must be a player id';
  if (typeof message.from !== 'string' || !/^pl_[0-9a-f]{16}$/.test(message.from)) return 'signal.from must be a player id';
  if (selfId !== null && message.from === selfId) return 'signal cannot come from self';
  if (selfId !== null && message.to !== selfId) return 'signal is addressed to another player';
  if (!validEpoch(message.epoch)) return 'signal.epoch must be a non-negative integer';
  if (message.type === 'signal.offer' || message.type === 'signal.answer') {
    if (!validSdp(message.sdp)) return 'signal.sdp is invalid';
    if (message.sdp.type !== message.type.slice('signal.'.length)) return 'signal.sdp.type does not match signal.type';
  } else if (message.type === 'signal.ice') {
    if (!validCandidate(message.candidate)) return 'signal.candidate is invalid';
  } else if (message.type === 'signal.bye') {
    if (message.reason !== undefined && typeof message.reason !== 'string') return 'signal.reason must be a string';
  }
  return null;
}

/** A signaling message the adapter sends; `from` is added by the server. */
export function makeOffer({ to, epoch, sdp }) {
  return { type: 'signal.offer', to, epoch, sdp: { type: 'offer', sdp } };
}

export function makeAnswer({ to, epoch, sdp }) {
  return { type: 'signal.answer', to, epoch, sdp: { type: 'answer', sdp } };
}

export function makeIce({ to, epoch, candidate }) {
  return { type: 'signal.ice', to, epoch, candidate: candidate ?? null };
}

export function makeBye({ to, epoch, reason = 'closed' }) {
  return { type: 'signal.bye', to, epoch, reason };
}

/**
 * The channel a data-plane message must use, or null when it is a room-service
 * message. Unknown `type` returns null on purpose so a malformed message is
 * rejected by the room service, not silently sent over a peer channel.
 */
export function channelForDataMessage(message) {
  if (!isObject(message) || typeof message.type !== 'string') return null;
  return DATA_PLANE_TYPES[message.type] ?? null;
}

export function isDataPlaneMessage(message) {
  return channelForDataMessage(message) !== null;
}

/**
 * Build the peer envelope. A direct peer must carry the identity the room
 * service normally adds: `from` and `authority`. Sequence numbers and payloads
 * are copied verbatim so the existing OrderedStream sees the same shape.
 */
export function makePeerEnvelope(message, { from, authority = false, now = null } = {}) {
  if (typeof from !== 'string') throw new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_CONFIG, 'peer envelope needs from');
  if (!isDataPlaneMessage(message)) {
    throw new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_CONFIG,
      'not a data-plane message: ' + String(message?.type), { type: message?.type ?? null });
  }
  const envelope = { ...message, from, authority: authority === true };
  if (message.type === 'state') {
    envelope.channel = 'state';
    if (now !== null) envelope.sentAt = now;
  } else if (message.type === 'input') {
    envelope.channel = 'input';
    if (now !== null) envelope.sentAt = now;
  }
  return envelope;
}

/** Validate a received peer envelope before dispatch. */
export function checkPeerEnvelope(message, peerId) {
  if (!isObject(message)) return 'peer message must be an object';
  if (typeof message.type !== 'string') return 'peer message needs type';
  const channel = channelForDataMessage(message);
  if (channel === null) return 'peer message type is not allowed on a data channel: ' + message.type;
  if (message.from !== peerId) return 'peer message.from does not match the sending peer';
  switch (message.type) {
    case 'state':
    case 'input':
      if (!validChannel(message.channel)) return 'peer channel is invalid';
      if (message.channel !== message.type) return 'peer channel does not match type';
      if (!validSeq(message.seq)) return 'peer sequence is invalid';
      if (!validTick(message.tick)) return 'peer tick is invalid';
      break;
    case 'ack':
      if (!validChannel(message.channel)) return 'ack channel is invalid';
      if (!validSeq(message.seq)) return 'ack sequence is invalid';
      break;
    case 'resync':
      if (!validChannel(message.channel)) return 'resync channel is invalid';
      if (!validSeq(message.fromSeq)) return 'resync sequence is invalid';
      break;
    case 'stream.final':
      if (!validChannel(message.channel)) return 'final channel is invalid';
      if (!validSeq(message.lastSeq)) return 'final sequence is invalid';
      if (!validTick(message.tick)) return 'final tick is invalid';
      break;
    case 'stream.error':
      if (!validChannel(message.channel)) return 'stream.error channel is invalid';
      if (typeof message.code !== 'string') return 'stream.error code is missing';
      break;
    default:
      return 'unhandled peer message';
  }
  return null;
}

export function utf8Length(text) {
  if (typeof text !== 'string') return 0;
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

export function encodePeerMessage(envelope) {
  return JSON.stringify(envelope);
}
