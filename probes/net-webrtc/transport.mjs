// WebRTC DataChannel transport adapter for the net-mvp room protocol.
//
// `WebRtcNetClient` is a drop-in `NetClient`: it has the same constructor
// surface, the same methods, the same events and the same `stats()` shape (with
// one extra `transport` block). Room/lobby messages still use the room service
// WebSocket; only the data plane moves to one DataChannel pair per peer.
//
//   state                    -> unreliable, unordered   (newer sample wins)
//   input/ack/resync/final   -> reliable, ordered       (never silently lost)
//
// Every failure produces a typed reason from `WEBRTC_ERROR_CODES`. If a
// DataChannel cannot be used, the same message is sent through the room service
// WebSocket (the committed net-mvp path) and a `transportFallback` event carries
// the reason. There is no silent downgrade: `transport.mode` becomes
// 'ws-fallback' and `transport.fallbackReason` is set.
//
// Both `RTCPeerConnection` and `WebSocket` are injected factories, so the whole
// adapter runs in Node against fakes (`fakes.mjs`). Pass the browser classes in
// a browser, or omit them to use the globals.

import { NetClient, NetError } from '../net-mvp/client.mjs';
import { ERROR_CODES, isObject } from '../net-mvp/protocol.mjs';

import {
  WEBRTC_ERROR_CODES,
  WebRtcError,
  CHANNEL_EVENT,
  CHANNEL_SNAPSHOT,
  CHANNEL_LABELS,
  CHANNEL_OPTIONS,
  TRANSPORT_MODES,
  channelForDataMessage,
  makePeerEnvelope,
  checkPeerEnvelope,
  checkSignal,
  makeOffer,
  makeAnswer,
  makeIce,
  makeBye,
  rejectTransportMode,
  validEpoch,
  utf8Length,
  encodePeerMessage
} from './protocol.mjs';

export const WEBRTC_SCHEMA = 'blur.net-webrtc.transport/1';
export const DEFAULT_PEER_LIMITS = Object.freeze({
  maxEventBufferedBytes: 256 * 1024,
  maxSnapshotBufferedBytes: 64 * 1024,
  negotiationTimeoutMs: 8000,
  iceRestartAttempts: 1,
  iceRestartDelayMs: 60,
  disconnectedGraceMs: 2000,
  peerRetryAttempts: 0,
  peerRetryDelayMs: 3000
});

export const DEFAULT_ICE_SERVERS = Object.freeze([]);

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function describeError(error) {
  return {
    name: String(error?.name ?? 'Error'),
    message: String(error?.message ?? error)
  };
}

function candidateInit(candidate) {
  if (!candidate) return null;
  if (typeof candidate.toJSON === 'function') {
    try { return candidate.toJSON(); } catch { /* fall through */ }
  }
  if (typeof candidate === 'object') {
    return {
      candidate: typeof candidate.candidate === 'string' ? candidate.candidate : '',
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null
    };
  }
  return null;
}

/**
 * One `RTCPeerConnection` and its two negotiated channels.
 *
 * Events are delivered through callbacks, never by throwing across a timer or a
 * browser event: a DataChannel error on one peer must not abort the room.
 */
export class WebRtcPeer {
  constructor({
    selfId, peerId, initiator, RTCPeerConnection, iceServers = [], rtcConfig = null,
    limits = {}, epoch = 1, signal = () => {}, onOpen = () => {}, onMessage = () => {},
    onFailure = () => {}, onState = () => {}, log = null
  } = {}) {
    if (typeof RTCPeerConnection !== 'function') {
      throw new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED, 'RTCPeerConnection is not available');
    }
    if (typeof selfId !== 'string' || typeof peerId !== 'string') {
      throw new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_CONFIG, 'peer needs selfId and peerId');
    }
    this.selfId = selfId;
    this.peerId = peerId;
    this.initiator = initiator === true;
    this.signal = signal;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onFailure = onFailure;
    this.onState = onState;
    this.log = log;
    this.epoch = epoch;
    this.limits = { ...DEFAULT_PEER_LIMITS, ...limits };

    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.opened = false;
    this.failed = false;
    this.closedByUser = false;
    this.restartAttempts = 0;
    this.startedAt = nowMs();
    this.openedAt = null;
    this.negotiationMs = null;
    this.disconnectedTimer = null;
    this.negotiationTimer = null;
    this.restartTimer = null;
    this.stats = {
      offersSent: 0,
      answersSent: 0,
      offersReceived: 0,
      answersReceived: 0,
      iceSent: 0,
      iceReceived: 0,
      iceQueued: 0,
      staleSignals: 0,
      stateChanges: 0,
      restartAttempts: 0
    };

    try {
      const configuration = { iceServers: [...(iceServers ?? [])], ...(rtcConfig ?? {}) };
      this.pc = new RTCPeerConnection(configuration);
    } catch (error) {
      throw new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_CONFIG,
        'RTCPeerConnection construction failed: ' + String(error?.message ?? error), describeError(error));
    }

    try {
      this.eventChannel = this.pc.createDataChannel(CHANNEL_LABELS[CHANNEL_EVENT], { ...CHANNEL_OPTIONS[CHANNEL_EVENT] });
      this.snapshotChannel = this.pc.createDataChannel(CHANNEL_LABELS[CHANNEL_SNAPSHOT], { ...CHANNEL_OPTIONS[CHANNEL_SNAPSHOT] });
    } catch (error) {
      this._terminal(WEBRTC_ERROR_CODES.WEBRTC_DATACHANNEL_FAILED,
        'createDataChannel failed: ' + String(error?.message ?? error), describeError(error));
      return;
    }

    this._wireChannel(this.eventChannel, CHANNEL_EVENT);
    this._wireChannel(this.snapshotChannel, CHANNEL_SNAPSHOT);
    this._wirePc();
    this._armNegotiationTimeout();
  }

  _wirePc() {
    const pc = this.pc;
    pc.onicecandidate = (event) => {
      if (this.failed || this.closedByUser) return;
      const candidate = candidateInit(event?.candidate ?? null);
      this.stats.iceSent += candidate ? 1 : 0;
      this._sendSignal(makeIce({ to: this.peerId, epoch: this.epoch, candidate }));
    };
    pc.onconnectionstatechange = () => this._onConnectionState();
    pc.oniceconnectionstatechange = () => this._onConnectionState();
    pc.ondatachannel = () => {
      // Both sides create negotiated channels with fixed ids, so an inbound
      // channel announcement is unexpected. It is counted, not wired: wiring a
      // second channel would break the fixed channel policy.
      this.stats.stateChanges++;
    };
  }

  _wireChannel(channel, kind) {
    if (!channel) return;
    channel.onopen = () => this._onChannelOpen(kind);
    channel.onclose = () => this._onChannelClose(kind);
    channel.onerror = (event) => {
      if (this.failed) return;
      this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_DATACHANNEL_FAILED,
        kind + ' data channel reported an error', { kind, error: describeError(event?.error ?? event) });
    };
    channel.onmessage = (event) => {
      if (this.failed || this.closedByUser) return;
      this.onMessage(this, kind, event?.data);
    };
  }

  _onChannelOpen(kind) {
    this.stats.stateChanges++;
    this.onState(this, kind);
    if (this._bothOpen()) this._opened();
  }

  _onChannelClose(kind) {
    this.stats.stateChanges++;
    if (this.failed || this.closedByUser) return;
    if (!this.opened) return; // negotiation close is handled by timeout/failure
    this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_DATACHANNEL_CLOSED, 'a data channel closed mid-session',
      { channel: kind });
  }

  _bothOpen() {
    return this.eventChannel?.readyState === 'open' && this.snapshotChannel?.readyState === 'open';
  }

  get ready() {
    return !this.failed && !this.closedByUser && this.opened && this._bothOpen();
  }

  get eventReady() {
    return !this.failed && !this.closedByUser && this.eventChannel?.readyState === 'open';
  }

  get snapshotReady() {
    return !this.failed && !this.closedByUser && this.snapshotChannel?.readyState === 'open';
  }

  _opened() {
    if (this.opened) return;
    this.opened = true;
    this.openedAt = nowMs();
    this.negotiationMs = this.openedAt - this.startedAt;
    clearTimeout(this.negotiationTimer);
    this.negotiationTimer = null;
    clearTimeout(this.disconnectedTimer);
    this.disconnectedTimer = null;
    this.restartAttempts = 0;
    this.onOpen(this);
  }

  _armNegotiationTimeout() {
    clearTimeout(this.negotiationTimer);
    this.negotiationTimer = setTimeout(() => {
      if (this.opened || this.failed || this.closedByUser) return;
      this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_ICE_TIMEOUT,
        'DataChannel negotiation timed out after ' + this.limits.negotiationTimeoutMs + ' ms',
        { timeoutMs: this.limits.negotiationTimeoutMs, epoch: this.epoch });
    }, this.limits.negotiationTimeoutMs);
    this.negotiationTimer.unref?.();
  }

  _onConnectionState() {
    if (this.failed || this.closedByUser) return;
    const state = this.pc.connectionState ?? this.pc.iceConnectionState;
    const ice = this.pc.iceConnectionState ?? state;
    this.onState(this, 'pc', { state, ice });
    if (state === 'connected' || ice === 'connected' || ice === 'completed') {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
      if (this._bothOpen()) this._opened();
      return;
    }
    if (state === 'failed' || ice === 'failed') {
      this._handleIceFailure(WEBRTC_ERROR_CODES.WEBRTC_ICE_FAILED, state + '/' + ice);
      return;
    }
    if (state === 'disconnected' || ice === 'disconnected') {
      this._armDisconnectedGrace(state + '/' + ice);
      return;
    }
    if (state === 'closed' || ice === 'closed') {
      this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_DATACHANNEL_CLOSED, 'peer connection closed', { state, ice });
    }
  }

  _armDisconnectedGrace(state) {
    if (this.disconnectedTimer) return;
    this.disconnectedTimer = setTimeout(() => {
      this.disconnectedTimer = null;
      if (this.failed || this.closedByUser) return;
      const current = this.pc.connectionState ?? this.pc.iceConnectionState;
      if (current === 'connected' || this.pc.iceConnectionState === 'connected' ||
          this.pc.iceConnectionState === 'completed') return;
      this._handleIceFailure(WEBRTC_ERROR_CODES.WEBRTC_ICE_DISCONNECTED,
        'ICE stayed disconnected for ' + this.limits.disconnectedGraceMs + ' ms');
    }, this.limits.disconnectedGraceMs);
    this.disconnectedTimer.unref?.();
  }

  _handleIceFailure(code, detail) {
    if (this.failed || this.closedByUser) return;
    if (this.opened && this.restartAttempts < this.limits.iceRestartAttempts) {
      this.restartAttempts++;
      this.stats.restartAttempts++;
      this.epoch++;
      this.onState(this, 'restart', { attempt: this.restartAttempts, code });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.failed || this.closedByUser) return;
        try { this.pc.restartIce?.(); } catch (error) {
          this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_ICE_RESTART_FAILED,
            'restartIce() failed: ' + String(error?.message ?? error), describeError(error));
          return;
        }
        this._beginNegotiation({ iceRestart: true }).catch((error) => {
          this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_ICE_RESTART_FAILED,
            'ICE restart offer failed: ' + String(error?.message ?? error), describeError(error));
        });
      }, this.limits.iceRestartDelayMs);
      this.restartTimer.unref?.();
      return;
    }
    this._sendFailure(code,
      'ICE failed after ' + this.restartAttempts + ' restart attempt(s)', { code, detail });
  }

  async _beginNegotiation({ iceRestart = false } = {}) {
    if (this.failed || this.closedByUser) return;
    if (!this.initiator) return;
    const offer = await this.pc.createOffer({ iceRestart });
    await this.pc.setLocalDescription(offer);
    this.stats.offersSent++;
    const description = this.pc.localDescription ?? offer;
    this._sendSignal(makeOffer({ to: this.peerId, epoch: this.epoch, sdp: description.sdp }));
    this._armNegotiationTimeout();
  }

  start() {
    if (!this.initiator || this.failed || this.closedByUser) return Promise.resolve(false);
    return this._beginNegotiation({ iceRestart: false }).then(() => true).catch((error) => {
      this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_OFFER_REJECTED,
        'createOffer failed: ' + String(error?.message ?? error), describeError(error));
      return false;
    });
  }

  async handleSignal(message) {
    if (this.failed || this.closedByUser) return;
    if (!validEpoch(message?.epoch)) {
      this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_SIGNAL_INVALID, 'signal epoch is invalid');
      return;
    }
    if (message.epoch < this.epoch) {
      this.stats.staleSignals++;
      return;
    }
    this.epoch = Math.max(this.epoch, message.epoch);
    try {
      if (message.type === 'signal.offer') {
        this.stats.offersReceived++;
        await this.pc.setRemoteDescription(message.sdp);
        this.remoteDescriptionSet = true;
        await this._flushCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.stats.answersSent++;
        const description = this.pc.localDescription ?? answer;
        this._sendSignal(makeAnswer({ to: this.peerId, epoch: this.epoch, sdp: description.sdp }));
        this._armNegotiationTimeout();
        return;
      }
      if (message.type === 'signal.answer') {
        this.stats.answersReceived++;
        if (this.remoteDescriptionSet) {
          this.stats.staleSignals++;
          return;
        }
        await this.pc.setRemoteDescription(message.sdp);
        this.remoteDescriptionSet = true;
        await this._flushCandidates();
        return;
      }
      if (message.type === 'signal.ice') {
        this.stats.iceReceived += message.candidate ? 1 : 0;
        if (!this.remoteDescriptionSet) {
          this.stats.iceQueued++;
          this.pendingCandidates.push(message.candidate);
          if (this.pendingCandidates.length > 256) {
            this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_SIGNAL_INVALID, 'too many queued ICE candidates');
          }
          return;
        }
        if (message.candidate) await this.pc.addIceCandidate(message.candidate);
        return;
      }
      if (message.type === 'signal.bye') {
        this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_PEER_LEFT, 'peer sent signal.bye', { reason: message.reason ?? null });
      }
    } catch (error) {
      this._sendFailure(WEBRTC_ERROR_CODES.WEBRTC_OFFER_REJECTED,
        'signal handling failed: ' + String(error?.message ?? error), describeError(error));
    }
  }

  async _flushCandidates() {
    const queued = this.pendingCandidates.splice(0, this.pendingCandidates.length);
    for (const candidate of queued) {
      if (candidate) await this.pc.addIceCandidate(candidate);
    }
  }

  _sendSignal(message) {
    if (this.closedByUser) return;
    try { this.signal(message); } catch { /* the WS may be reconnecting; signal is retried by retry */ }
  }

  send(kind, text) {
    const channel = kind === CHANNEL_EVENT ? this.eventChannel : this.snapshotChannel;
    const bytes = utf8Length(text);
    if (!channel || channel.readyState !== 'open') {
      return { ok: false, reason: WEBRTC_ERROR_CODES.WEBRTC_DATACHANNEL_CLOSED, bytes };
    }
    const cap = kind === CHANNEL_EVENT ? this.limits.maxEventBufferedBytes : this.limits.maxSnapshotBufferedBytes;
    const buffered = Number(channel.bufferedAmount) || 0;
    if (buffered + bytes > cap) {
      return { ok: false, reason: WEBRTC_ERROR_CODES.WEBRTC_BUFFER_FULL, bytes, buffered, cap };
    }
    try {
      channel.send(text);
      return { ok: true, bytes, bufferedAfter: (Number(channel.bufferedAmount) || 0) };
    } catch (error) {
      return { ok: false, reason: WEBRTC_ERROR_CODES.WEBRTC_SEND_FAILED, bytes, error: describeError(error) };
    }
  }

  _sendFailure(code, message, detail = null) {
    if (this.failed) return;
    this._terminal(code, message, detail);
  }

  _terminal(code, message, detail = null) {
    if (this.failed) return;
    this.failed = true;
    this.opened = false;
    clearTimeout(this.negotiationTimer);
    clearTimeout(this.disconnectedTimer);
    clearTimeout(this.restartTimer);
    this.negotiationTimer = null;
    this.disconnectedTimer = null;
    this.restartTimer = null;
    const failure = { code, message, detail, peerId: this.peerId, epoch: this.epoch, at: nowMs() };
    this.onFailure(this, failure);
    try { this.pc.close(); } catch { /* already closed */ }
  }

  /** Test/ops hook: force a failure without waiting for ICE timers. */
  failNow(code = WEBRTC_ERROR_CODES.WEBRTC_ICE_FAILED, message = 'forced ICE failure') {
    this._terminal(code, message, { forced: true });
  }

  close({ notify = true } = {}) {
    if (this.closedByUser) return;
    this.closedByUser = true;
    clearTimeout(this.negotiationTimer);
    clearTimeout(this.disconnectedTimer);
    clearTimeout(this.restartTimer);
    if (notify && !this.failed) {
      this._sendSignal(makeBye({ to: this.peerId, epoch: this.epoch }));
    }
    try { this.eventChannel?.close?.(); } catch { /* ignore */ }
    try { this.snapshotChannel?.close?.(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
  }

  statsView() {
    return {
      peerId: this.peerId,
      initiator: this.initiator,
      epoch: this.epoch,
      ready: this.ready,
      opened: this.opened,
      failed: this.failed,
      negotiationMs: this.negotiationMs,
      restartAttempts: this.restartAttempts,
      eventChannelState: this.eventChannel?.readyState ?? 'none',
      snapshotChannelState: this.snapshotChannel?.readyState ?? 'none',
      eventBufferedAmount: Number(this.eventChannel?.bufferedAmount) || 0,
      snapshotBufferedAmount: Number(this.snapshotChannel?.bufferedAmount) || 0,
      ...this.stats
    };
  }
}

export class WebRtcNetClient extends NetClient {
  constructor(options = {}) {
    super(options);
    const {
      transport = 'auto',
      RTCPeerConnection: RtcImpl = globalThis.RTCPeerConnection,
      WebSocket: WebSocketImpl = globalThis.WebSocket,
      iceServers = DEFAULT_ICE_SERVERS,
      rtcConfig = null,
      peerLimits = {},
      signalTransport = null,
      log = null
    } = options;

    this._transportMode = rejectTransportMode(transport);
    this._rtcImpl = typeof RtcImpl === 'function' ? RtcImpl : null;
    this._wsImpl = typeof WebSocketImpl === 'function' ? WebSocketImpl : globalThis.WebSocket;
    if (typeof this._wsImpl !== 'function') {
      throw new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_CONFIG, 'no WebSocket implementation available');
    }
    this._iceServers = Array.isArray(iceServers) ? iceServers : [];
    this._rtcConfig = rtcConfig;
    this._peerLimits = { ...DEFAULT_PEER_LIMITS, ...peerLimits };
    this._signalTransport = signalTransport && typeof signalTransport.send === 'function'
      ? signalTransport
      : null;
    this._pendingSignals = [];
    if (this._signalTransport && typeof this._signalTransport.onMessage === 'function') {
      this._signalTransport.onMessage((message) => {
        if (!isObject(message)) return;
        if (this.playerId && message.from === this.playerId) return;
        if (this._room && message.roomCode && message.roomCode !== this._room.code) return;
        this._onSignal(message);
      });
    }
    this._log = log;
    this._peers = new Map();
    this._peerEpoch = 0;
    this._permanentWs = this._transportMode === 'ws';
    this._initialFallback = null;

    if (this._transportMode !== 'ws' && !this._rtcImpl) {
      if (this._transportMode === 'webrtc') {
        throw new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED,
          'transport:"webrtc" requires an RTCPeerConnection implementation');
      }
      this._permanentWs = true;
      this._initialFallback = {
        code: WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED,
        message: 'RTCPeerConnection is not available in this environment'
      };
    }

    this._transport = {
      mode: this._permanentWs ? 'ws-fallback' : 'webrtc',
      configured: this._transportMode,
      rtcSupported: Boolean(this._rtcImpl),
      fallbackCount: 0,
      fallbackReason: this._initialFallback ? WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED : null,
      lastFallback: this._initialFallback
        ? { ...this._initialFallback, peerId: null, at: nowMs() }
        : null,
      snapshotDropped: 0,
      eventSendFailures: 0,
      invalidMessages: 0,
      signalsSent: 0,
      signalsReceived: 0,
      signalErrors: 0,
      bytesSent: { event: 0, snapshot: 0 },
      bytesReceived: { event: 0, snapshot: 0 },
      messagesSent: { event: 0, snapshot: 0 },
      messagesReceived: { event: 0, snapshot: 0 },
      messagesByType: {},
      peerRetries: 0,
      renegotiations: 0,
      retryTimers: new Set()
    };
    this._syncTimer = null;
  }

  // ------------------------------------------------------------- transport
  _openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new NetError(ERROR_CODES.NET_TIMEOUT, 'welcome timed out', { url: this.url }));
        try { this._socket?.close(4000, 'welcome timeout'); } catch { /* ignore */ }
      }, this.requestTimeoutMs);

      let socket;
      try {
        socket = new this._wsImpl(this.url);
      } catch (error) {
        finish(new NetError(ERROR_CODES.NET_CONFIG,
          'WebSocket construction failed: ' + String(error?.message ?? error)));
        return;
      }
      this._socket = socket;
      this._welcome = null;
      this._stats.connects++;
      socket.addEventListener('message', (event) => {
        if (this._socket !== socket) return;
        this._onMessage(event, finish);
      });
      socket.addEventListener('close', (event) => {
        if (this._socket !== socket) {
          if (!settled) {
            finish(new NetError(ERROR_CODES.NET_CLOSED, 'socket closed before welcome',
              { code: event.code, reason: event.reason }));
          }
          return;
        }
        this._handleClose(event);
        if (!settled) {
          finish(new NetError(ERROR_CODES.NET_CLOSED, 'socket closed before welcome',
            { code: event.code, reason: event.reason }));
        }
      });
      socket.addEventListener('error', () => {
        if (!settled) finish(new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'WebSocket error before welcome'));
      });
      socket.addEventListener('open', () => {});
    });
  }

  async connect() {
    const welcome = await super.connect();
    if (this._initialFallback && !this._initialFallbackEmitted) {
      this._initialFallbackEmitted = true;
      this._emit('transportFallback', {
        code: WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED,
        reason: WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED,
        message: this._initialFallback.message,
        peerId: null,
        transportMode: 'ws-fallback',
        at: nowMs()
      });
    }
    return welcome;
  }

  // --------------------------------------------------------------- dispatch
  _dispatch(message) {
    if (isObject(message) && typeof message.type === 'string' && message.type.startsWith('signal.')) {
      return this._onSignal(message);
    }
    super._dispatch(message);
    if (message.type === 'room.created' || message.type === 'room.joined' ||
        message.type === 'room.state' || message.type === 'room.started' ||
        message.type === 'player.resumed' || message.type === 'welcome') {
      if (this._pendingSignals.length) {
        const queued = this._pendingSignals.splice(0, this._pendingSignals.length);
        for (const signal of queued) this._onSignal(signal);
      }
      this._schedulePeerSync();
    }
    if (message.type === 'player.left') {
      this._dropPeer(message.playerId, WEBRTC_ERROR_CODES.WEBRTC_PEER_LEFT);
    }
  }

  _onSignal(message) {
    this._transport.signalsReceived++;
    if (this._signalTransport && message?.roomCode && this._room && message.roomCode !== this._room.code) return;
    if (!this.playerId || !this._room) {
      if (this._pendingSignals.length < 64) this._pendingSignals.push(message);
      return;
    }
    const problem = checkSignal(message, this.playerId);
    if (problem) {
      this._transport.signalErrors++;
      this._emit('error', new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_SIGNAL_INVALID,
        'invalid signaling message: ' + problem, { problem, type: message?.type ?? null }));
      return;
    }
    if (this._permanentWs) return; // late signal after a permanent fallback
    if (!this._room || !this._room.players.some((player) => player.id === message.from)) {
      this._transport.signalErrors++;
      this._emit('error', new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_SIGNAL_UNKNOWN_PEER,
        'signaling message from a player outside the room', { from: message.from }));
      return;
    }
    let peer = this._peers.get(message.from);
    if (!peer) {
      peer = this._createPeer(message.from, {
        initiator: false,
        epoch: Math.max(1, Number(message.epoch) || 1)
      });
      if (!peer) return;
    }
    peer.handleSignal(message).catch((error) => {
      this._transport.signalErrors++;
      this._emit('error', new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_SIGNAL_INVALID,
        'signaling handling failed', describeError(error)));
    });
  }

  _sendSignal(message) {
    try {
      if (this._signalTransport) {
        this._signalTransport.send({ ...message, from: this.playerId, roomCode: this._room?.code ?? null });
        this._transport.signalsSent++;
        return;
      }
      super._sendMessage(message);
      this._transport.signalsSent++;
    } catch (error) {
      this._transport.signalErrors++;
      this._emit('error', new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_SIGNAL_INVALID,
        'could not send signaling message', describeError(error)));
    }
  }

  // ----------------------------------------------------------------- peers
  _schedulePeerSync() {
    if (this._permanentWs || this._transportMode === 'ws') return;
    if (this._syncTimer) return;
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this._syncPeers();
    }, 0);
    this._syncTimer.unref?.();
  }

  _syncPeers() {
    if (this._permanentWs || this._transportMode === 'ws' || !this._room || !this.playerId) return;
    const roster = this._room.players ?? [];
    const self = roster.find((player) => player.id === this.playerId);
    if (!self) return;
    const connectedIds = new Set(roster.map((player) => player.id));
    for (const peer of [...this._peers.values()]) {
      if (!connectedIds.has(peer.peerId)) this._dropPeer(peer.peerId, WEBRTC_ERROR_CODES.WEBRTC_PEER_LEFT);
    }
    for (const player of roster) {
      if (player.id === this.playerId) continue;
      if (this._peers.has(player.id)) continue;
      if (this._peers.size >= 7) break; // two-player gate; full mesh is a bounded next step
      const shouldInitiate = self.slot < player.slot;
      if (!shouldInitiate) continue; // the responder waits for the offer
      this._createPeer(player.id, { initiator: true, epoch: ++this._peerEpoch }).start();
    }
  }

  _createPeer(peerId, { initiator, epoch }) {
    if (!this._rtcImpl) return null;
    let peer;
    try {
      peer = new WebRtcPeer({
        selfId: this.playerId,
        peerId,
        initiator,
        RTCPeerConnection: this._rtcImpl,
        iceServers: this._iceServers,
        rtcConfig: this._rtcConfig,
        limits: this._peerLimits,
        epoch,
        signal: (message) => this._sendSignal(message),
        onOpen: (opened) => this._onPeerOpen(opened),
        onMessage: (from, kind, data) => this._onPeerMessage(from, kind, data),
        onFailure: (failed, failure) => this._onPeerFailure(failed, failure),
        onState: (from, state, detail) => this._onPeerState(from, state, detail),
        log: this._log
      });
    } catch (error) {
      this._transport.fallbackCount++;
      this._transport.fallbackReason = error?.code ?? WEBRTC_ERROR_CODES.WEBRTC_CONFIG;
      this._transport.lastFallback = {
        code: this._transport.fallbackReason,
        message: String(error?.message ?? error),
        peerId,
        at: nowMs()
      };
      this._emit('error', error instanceof NetError ? error : new WebRtcError(
        WEBRTC_ERROR_CODES.WEBRTC_CONFIG, String(error?.message ?? error)));
      return null;
    }
    this._peers.set(peerId, peer);
    return peer;
  }

  _onPeerOpen(peer) {
    if (this._transport.mode !== 'webrtc') this._transport.renegotiations++;
    this._transport.mode = 'webrtc';
    this._emit('transportReady', {
      peerId: peer.peerId,
      epoch: peer.epoch,
      negotiationMs: peer.negotiationMs,
      mode: 'webrtc'
    });
  }

  _onPeerState(peer, state, detail) {
    this._emit('transportState', { peerId: peer.peerId, state, detail: detail ?? null, epoch: peer.epoch });
  }

  _onPeerFailure(peer, failure) {
    this._dropPeer(peer.peerId, failure.code, { failure, keepRecord: false });
    this._transport.fallbackCount++;
    this._transport.fallbackReason = failure.code;
    this._transport.lastFallback = { ...failure, at: nowMs() };
    const anyReady = [...this._peers.values()].some((entry) => entry.ready);
    if (!anyReady) this._transport.mode = 'ws-fallback';
    this._emit('transportFallback', {
      code: failure.code,
      reason: failure.code,
      message: failure.message,
      detail: failure.detail ?? null,
      peerId: failure.peerId,
      epoch: failure.epoch,
      transportMode: 'ws-fallback',
      at: nowMs()
    });
    if (this._peerLimits.peerRetryAttempts > 0 && this._transport.peerRetries < this._peerLimits.peerRetryAttempts) {
      this._transport.peerRetries++;
      const timer = setTimeout(() => {
        this._transport.retryTimers.delete(timer);
        if (this._permanentWs || !this._room) return;
        const self = this._room.players.find((player) => player.id === this.playerId);
        const other = this._room.players.find((player) => player.id === peer.peerId);
        if (!self || !other || self.slot >= other.slot) return;
        this._createPeer(peer.peerId, { initiator: true, epoch: ++this._peerEpoch })?.start();
      }, this._peerLimits.peerRetryDelayMs);
      timer.unref?.();
      this._transport.retryTimers.add(timer);
    }
  }

  _dropPeer(peerId, code, { keepRecord = false } = {}) {
    const peer = this._peers.get(peerId);
    if (!peer) return false;
    this._peers.delete(peerId);
    peer.close({ notify: false });
    if (!keepRecord) {
      this._emit('transportPeerClosed', { peerId, code });
    }
    return true;
  }

  // --------------------------------------------------------------- routing
  _connectedRemoteCount() {
    if (!this._room) return 0;
    return (this._room.players ?? []).filter((player) => player.id !== this.playerId).length;
  }

  _targetsFor(message, kind) {
    const peers = [...this._peers.values()];
    switch (message.type) {
      case 'state':
      case 'input':
      case 'stream.final':
        return peers.filter((peer) => peer.ready);
      case 'ack':
      case 'resync':
      case 'stream.error': {
        if (typeof message.to !== 'string') return [];
        const peer = this._peers.get(message.to);
        return peer && peer.ready ? [peer] : [];
      }
      default:
        return [];
    }
  }

  _countSent(kind, type, bytes) {
    this._transport.bytesSent[kind] += bytes;
    this._transport.messagesSent[kind]++;
    const entry = this._transport.messagesByType[type] ?? { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 };
    entry.sent++;
    entry.bytesSent += bytes;
    this._transport.messagesByType[type] = entry;
  }

  _countReceived(kind, type, bytes) {
    this._transport.bytesReceived[kind] += bytes;
    this._transport.messagesReceived[kind]++;
    const entry = this._transport.messagesByType[type] ?? { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 };
    entry.received++;
    entry.bytesReceived += bytes;
    this._transport.messagesByType[type] = entry;
  }

  _route(message) {
    if (this._permanentWs || this._transportMode === 'ws') return false;
    const kind = channelForDataMessage(message);
    if (kind === null) return false;
    if (!this._room || !this.playerId) return false;

    const targets = this._targetsFor(message, kind);
    const remoteCount = this._connectedRemoteCount();
    if (targets.length === 0) return false;
    // A broadcast must reach every peer. If any peer is still negotiating or
    // failed, the whole message goes through the room service so the stream has
    // no transport-shaped hole. Targeted messages need only their one peer.
    const broadcast = message.type === 'state' || message.type === 'input' || message.type === 'stream.final';
    if (broadcast && targets.length !== remoteCount) return false;

    let delivered = 0;
    let dropped = 0;
    for (const peer of targets) {
      let envelope;
      try {
        envelope = makePeerEnvelope(message, { from: this.playerId, authority: this.isHost });
      } catch (error) {
        this._transport.eventSendFailures++;
        this._emit('error', error);
        return false;
      }
      const text = encodePeerMessage(envelope);
      const result = peer.send(kind, text);
      if (result.ok) {
        delivered++;
        this._countSent(kind, message.type, result.bytes);
        continue;
      }
      if (kind === CHANNEL_SNAPSHOT && result.reason === WEBRTC_ERROR_CODES.WEBRTC_BUFFER_FULL) {
        // Snapshots are state, not events: a full snapshot buffer drops the
        // sample and counts it. It must never delay the event channel.
        this._transport.snapshotDropped++;
        dropped++;
        this._emit('snapshotDropped', {
          peerId: peer.peerId, bytes: result.bytes, buffered: result.buffered, cap: result.cap, at: nowMs()
        });
        continue;
      }
      // A reliable message (or a snapshot send that is not a cap drop) must not
      // vanish. Record the typed reason and retry the message on the WS path.
      this._transport.eventSendFailures++;
      this._emit('error', new WebRtcError(result.reason ?? WEBRTC_ERROR_CODES.WEBRTC_SEND_FAILED,
        'data channel send failed; falling back to the room service', {
          peerId: peer.peerId, kind, type: message.type, detail: result.error ?? null
        }));
      this._transitionFallback(peer, result.reason ?? WEBRTC_ERROR_CODES.WEBRTC_SEND_FAILED,
        message.type);
      return false;
    }
    // A snapshot that was dropped by the local cap is a handled unreliable
    // sample, not a reason to resend it on the reliable WebSocket path.
    return delivered > 0 || (kind === CHANNEL_SNAPSHOT && dropped === targets.length);
  }

  _transitionFallback(peer, code, messageType) {
    this._transport.fallbackCount++;
    this._transport.fallbackReason = code;
    this._transport.lastFallback = {
      code, peerId: peer.peerId, message: 'send failed', messageType, at: nowMs()
    };
    this._transport.mode = 'ws-fallback';
    this._emit('transportFallback', {
      code,
      reason: code,
      message: 'send failed on the data channel',
      messageType,
      peerId: peer.peerId,
      transportMode: 'ws-fallback',
      at: nowMs()
    });
    this._dropPeer(peer.peerId, code);
  }

  _sendMessage(message) {
    if (this._route(message)) return;
    return super._sendMessage(message);
  }

  _onPeerMessage(peer, kind, data) {
    let text;
    try {
      if (typeof data === 'string') text = data;
      else if (typeof data?.text === 'function') text = data.text();
      else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
      else text = String(data);
    } catch (error) {
      this._transport.invalidMessages++;
      this._emit('error', new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_MESSAGE_INVALID,
        'peer message could not be decoded', describeError(error)));
      if (kind === CHANNEL_EVENT) this._transitionFallback(peer, WEBRTC_ERROR_CODES.WEBRTC_MESSAGE_INVALID, 'decode');
      return;
    }
    let message;
    try { message = JSON.parse(text); } catch (error) {
      this._transport.invalidMessages++;
      this._emit('error', new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_MESSAGE_INVALID,
        'peer message is not JSON', describeError(error)));
      if (kind === CHANNEL_EVENT) this._transitionFallback(peer, WEBRTC_ERROR_CODES.WEBRTC_MESSAGE_INVALID, 'json');
      return;
    }
    const problem = checkPeerEnvelope(message, peer.peerId);
    if (problem) {
      this._transport.invalidMessages++;
      this._emit('error', new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_MESSAGE_INVALID,
        'invalid peer envelope: ' + problem, { problem, peerId: peer.peerId }));
      if (kind === CHANNEL_EVENT) this._transitionFallback(peer, WEBRTC_ERROR_CODES.WEBRTC_MESSAGE_INVALID, message?.type ?? null);
      return;
    }
    if (typeof message.to === 'string' && message.to !== this.playerId) {
      this._transport.invalidMessages++;
      this._emit('error', new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_MESSAGE_INVALID,
        'peer message addressed to another player', { to: message.to }));
      return;
    }
    this._countReceived(kind, message.type, utf8Length(text));
    try {
      this._dispatch(message);
    } catch (error) {
      const netError = error instanceof NetError ? error : new NetError(
        ERROR_CODES.NET_PROTOCOL, String(error?.message ?? error));
      this._emit('error', netError);
      if (kind === CHANNEL_EVENT) this._transitionFallback(peer, WEBRTC_ERROR_CODES.WEBRTC_MESSAGE_INVALID, message.type);
    }
  }

  // ------------------------------------------------------------------ hooks
  /** Force both halves of the local peer connection to fail (test/ops hook). */
  simulateIceFailure({ hard = true } = {}) {
    if (hard) this._permanentWs = true;
    const peers = [...this._peers.values()];
    for (const peer of peers) peer.failNow(WEBRTC_ERROR_CODES.WEBRTC_ICE_FAILED, 'forced ICE failure');
    return { peers: peers.length, hard };
  }

  /** Report whether every room peer currently has both channels open. */
  peerReady() {
    return [...this._peers.values()].filter((peer) => peer.ready).length;
  }

  transportStats() {
    return {
      schema: WEBRTC_SCHEMA,
      mode: this._permanentWs ? (this._transport.fallbackReason ? 'ws-fallback' : 'ws') : this._transport.mode,
      configured: this._transportMode,
      rtcSupported: this._transport.rtcSupported,
      wsSupported: typeof this._wsImpl === 'function',
      fallbackCount: this._transport.fallbackCount,
      fallbackReason: this._transport.fallbackReason,
      lastFallback: this._transport.lastFallback,
      snapshotDropped: this._transport.snapshotDropped,
      eventSendFailures: this._transport.eventSendFailures,
      invalidMessages: this._transport.invalidMessages,
      signalsSent: this._transport.signalsSent,
      signalsReceived: this._transport.signalsReceived,
      signalErrors: this._transport.signalErrors,
      bytesSent: { ...this._transport.bytesSent },
      bytesReceived: { ...this._transport.bytesReceived },
      messagesSent: { ...this._transport.messagesSent },
      messagesReceived: { ...this._transport.messagesReceived },
      messagesByType: JSON.parse(JSON.stringify(this._transport.messagesByType)),
      peerRetries: this._transport.peerRetries,
      renegotiations: this._transport.renegotiations,
      iceServers: this._iceServers.length,
      peers: [...this._peers.values()].map((peer) => peer.statsView())
    };
  }

  stats() {
    return { ...super.stats(), transport: this.transportStats() };
  }

  close() {
    for (const timer of this._transport.retryTimers) clearTimeout(timer);
    this._transport.retryTimers.clear();
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    for (const peer of [...this._peers.values()]) {
      try { peer.close({ notify: true }); } catch { /* ignore */ }
    }
    this._peers.clear();
    try { this._signalTransport?.close?.(); } catch { /* ignore */ }
    super.close();
  }
}

export { NetError, ERROR_CODES, WEBRTC_ERROR_CODES };
export { CHANNEL_EVENT, CHANNEL_SNAPSHOT };
