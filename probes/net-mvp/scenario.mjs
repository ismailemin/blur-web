// Shared headless scenario helpers for the capacity, soak and reconnect gates.
//
// These are the same deterministic drivers the 4-client harness uses: 60 Hz
// input, 20 Hz state, per-sender sequence numbers, strict ordered application
// and the synthetic race from race.mjs. No game assets and no browser.

import { NetClient, NetError } from './client.mjs';
import { ERROR_CODES } from './protocol.mjs';
import { stateAt, inputAt, finalHash, finalTickForSeconds } from './race.mjs';

export const CARS = [
  'corvette-zr1-stock',
  'lotus-exige-cup260',
  'dodge-challenger-stock',
  'audi-r8v10-stock',
  'nissan-350znismo-stock',
  'toyota-supratrd-stock',
  'koenigsegg-ccxr-stock',
  'volkswagen-beetle-offroad'
];

const NAMES = [
  'Host', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa',
  'Quebec', 'Romeo', 'Sierra', 'Tango'
];

export function rosterFor(players) {
  if (!Number.isInteger(players) || players < 2 || players > 20) {
    throw new Error('players must be 2..20');
  }
  return NAMES.slice(0, players).map((name, index) => ({ name, car: CARS[index % CARS.length] }));
}

export function waitEvent(client, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const off = client.on(event, (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
    const timer = setTimeout(() => {
      off();
      reject(new NetError(ERROR_CODES.NET_TIMEOUT, 'timed out waiting for ' + event));
    }, timeoutMs);
  });
}

export class RaceDriver {
  constructor(client, { finalTick, seed }) {
    this.client = client;
    this.finalTick = finalTick;
    this.seed = seed;
    this.startedAt = null;
    this.nextTick = 1;
    this.timer = null;
    this.done = null;
    this.sendErrors = [];
    this.sentStates = 0;
    this.sentInputs = 0;
  }

  start() {
    this.startedAt = Date.now();
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
    this.timer = setInterval(() => this.pump(), 4);
    this.pump();
    return this.done;
  }

  pump() {
    if (this.nextTick > this.finalTick) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.resolveDone?.();
      return;
    }
    if (!this.client.connected || this.client.room?.phase !== 'running') return;
    const target = Math.min(this.finalTick, 1 + Math.floor((Date.now() - this.startedAt) * 60 / 1000));
    const self = this.client.room.players.find((player) => player.id === this.client.playerId);
    if (!self) return;
    while (this.nextTick <= target) {
      const tick = this.nextTick++;
      try {
        this.client.sendInput(inputAt(this.seed, self.slot, tick), tick);
        this.sentInputs++;
        if (tick % 3 === 0 || tick === this.finalTick) {
          this.client.sendState(stateAt(this.seed, self.slot, self.car, tick));
          this.sentStates++;
        }
      } catch (error) {
        // A reconnect or a stall closes the socket in the middle of a burst.
        // The tick is skipped; the driver resumes after the token restores the
        // room. Any other error is recorded and surfaced.
        if (error?.code === ERROR_CODES.NET_NOT_CONNECTED) return;
        this.sendErrors.push({ tick, code: error?.code ?? null, message: String(error?.message || error) });
        return;
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export async function connectClients({ server, players, url = null, impairmentFor = null }) {
  const roster = rosterFor(players);
  const clients = [];
  const errors = [];
  for (let index = 0; index < players; index++) {
    const client = new NetClient({
      url: url ?? server.wsUrl,
      name: roster[index].name,
      autoReconnect: true,
      impairment: impairmentFor ? impairmentFor(index) : null
    });
    client.on('error', (error) => errors.push({
      client: roster[index].name,
      error: error?.toJSON?.() ?? { message: String(error) }
    }));
    client.on('fatal', (error) => errors.push({
      client: roster[index].name,
      fatal: true,
      error: error?.toJSON?.() ?? { message: String(error) }
    }));
    clients.push(client);
  }
  await Promise.all(clients.map((client) => client.connect()));
  return { roster, clients, errors };
}

export async function openRoom(clients, roster, { maxPlayers = undefined, seed = 'blur-net-mvp-scenario-v1' } = {}) {
  const created = await clients[0].createRoom({
    name: roster[0].name,
    maxPlayers,
    map: 'usa_la_river',
    car: roster[0].car
  });
  const code = created.room.code;
  for (let index = 1; index < clients.length; index++) {
    await clients[index].joinRoom({ code, name: roster[index].name, car: roster[index].car });
  }
  await Promise.all(clients.map((client) => client.setReady(true)));
  const startedEvents = clients.map((client) => waitEvent(client, 'started', 10_000));
  const started = await clients[0].start({ seed });
  await Promise.all(startedEvents);
  return { code, started, room: created.room };
}

export async function runToFinish({ clients, roster, seconds, seed, drainMs = 400, timeoutMs = null }) {
  const finalTick = finalTickForSeconds(seconds);
  const wallStart = Date.now();
  const drivers = clients.map((client) => new RaceDriver(client, { finalTick, seed }));
  const done = Promise.all(drivers.map((driver) => driver.start()));
  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(
      () => reject(new NetError(ERROR_CODES.NET_TIMEOUT, 'race drivers timed out')),
      timeoutMs ?? seconds * 1000 + 20_000
    ))
  ]);
  await new Promise((resolve) => setTimeout(resolve, drainMs));
  for (const driver of drivers) driver.stop();
  const raceElapsedMs = Date.now() - wallStart;

  for (const client of clients) client.finalizeStreams();
  await Promise.all(clients.map((client) => client.waitForStreams(15_000)));

  const tables = clients.map((client) => client.buildFinalTable(finalTick));
  const hashes = tables.map((table) => finalHash({ seed, tick: finalTick, players: table }));
  const finishedEvents = clients.map((client) => waitEvent(client, 'finished', 8000));
  await Promise.all(clients.map((client, index) => client.reportFinished({ tick: finalTick, hash: hashes[index] })));
  await Promise.all(finishedEvents);

  return {
    finalTick,
    raceElapsedMs,
    tables,
    hashes,
    drivers: drivers.map((driver, index) => ({
      client: roster[index].name,
      sentStates: driver.sentStates,
      sentInputs: driver.sentInputs,
      sendErrors: driver.sendErrors
    }))
  };
}

/** Strict per-receiver/sender sequence convergence rows. */
export function sequenceRows(clients, roster) {
  const rows = [];
  let ok = true;
  for (let receiverIndex = 0; receiverIndex < clients.length; receiverIndex++) {
    const client = clients[receiverIndex];
    const stats = client.stats();
    for (const sender of clients) {
      if (sender.playerId === client.playerId) continue;
      const stream = stats.streams.find((row) => row.from === sender.playerId && row.channel === 'state');
      const input = stats.streams.find((row) => row.from === sender.playerId && row.channel === 'input');
      const expectedTarget = sender.stats().sent.state;
      const expectedInputTarget = sender.stats().sent.input;
      const row = {
        receiver: roster[receiverIndex].name,
        sender: sender.name,
        target: stream?.target ?? null,
        expectedTarget,
        lastApplied: stream?.lastApplied ?? 0,
        appliedSeqCount: stream?.appliedSeqCount ?? 0,
        duplicates: stream?.duplicates ?? 0,
        outOfOrderBuffered: stream?.outOfOrderBuffered ?? 0,
        violations: stream?.violations ?? 0,
        converged: stream?.converged ?? false,
        inputTarget: input?.target ?? null,
        expectedInputTarget,
        inputLastApplied: input?.lastApplied ?? 0
      };
      if (row.target !== expectedTarget || row.lastApplied !== expectedTarget ||
          row.appliedSeqCount !== expectedTarget || row.lastApplied !== row.appliedSeqCount ||
          row.violations !== 0 || row.converged !== true ||
          row.inputTarget !== expectedInputTarget || row.inputLastApplied !== expectedInputTarget) {
        ok = false;
      }
      rows.push(row);
    }
  }
  return { rows, ok };
}

/** Server-side wire bytes per client over the measured race window. */
export function bandwidthReport(server, clients, elapsedSeconds) {
  const rows = server.bandwidth();
  const byPlayer = new Map();
  for (const client of clients) {
    const row = rows.find((entry) => entry.playerId === client.playerId);
    byPlayer.set(client.playerId, row ?? null);
  }
  const perClient = clients.map((client) => {
    const stats = client.stats();
    const row = byPlayer.get(client.playerId);
    const bytesIn = row?.bytesIn ?? 0;
    const bytesOut = row?.bytesOut ?? 0;
    return {
      name: client.name,
      playerId: client.playerId,
      slot: stats.playerSlot,
      bytesIn,
      bytesOut,
      bytesInPerSecond: Math.round(bytesIn / elapsedSeconds),
      bytesOutPerSecond: Math.round(bytesOut / elapsedSeconds),
      kbitInPerSecond: Math.round((bytesIn * 8 / 1000) / elapsedSeconds),
      kbitOutPerSecond: Math.round((bytesOut * 8 / 1000) / elapsedSeconds),
      sent: stats.sent,
      received: stats.received
    };
  });
  return {
    elapsedSeconds,
    perClient,
    totals: {
      bytesIn: perClient.reduce((sum, row) => sum + row.bytesIn, 0),
      bytesOut: perClient.reduce((sum, row) => sum + row.bytesOut, 0),
      bytesInPerSecond: Math.round(perClient.reduce((sum, row) => sum + row.bytesIn, 0) / elapsedSeconds),
      bytesOutPerSecond: Math.round(perClient.reduce((sum, row) => sum + row.bytesOut, 0) / elapsedSeconds)
    }
  };
}

export function closeClients(clients) {
  for (const client of clients) {
    try { client.close(); } catch { /* already closed */ }
  }
}
