// Build _work/split-screen/plan.json from the layout and budget contracts.
//
//   node probes/split-screen/build-plan.mjs
//
// The plan is deterministic: the same inputs produce byte-identical JSON and
// the same planHash. It is a design record, not a renderer.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANVAS, FOV_POLICY, LAYOUTS } from './layout.mjs';
import {
  CAR, CAR_ENVELOPE, DRAW_UNIFORM_STRIDE, FRAME_ANCHOR, MAPS, MAP_IDS, PLAYER_COUNTS,
  REMOTE_LOD_DRAWS, drawBoundForDraws, drawBoundMs, feasibility, frameBudgetMs, frameWork,
  geometryMemory, linearViewMs, lodFrameDraws, lodPerViewDraws, perDrawMs, perViewWork,
  textureMemory, oneViewMs
} from './budget.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLAN_PATH = join(ROOT, '_work', 'split-screen', 'plan.json');

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Stable JSON: object keys sorted at every level, numbers untouched. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function planHash(plan) {
  const copy = { ...plan };
  delete copy.planHash;
  return 'sha256:' + createHash('sha256').update(canonicalJson(copy)).digest('hex');
}

function tableFor(mapId) {
  const rows = [];
  for (const players of PLAYER_COUNTS) {
    const perView = perViewWork(mapId, players);
    const frame = frameWork(mapId, players);
    rows.push({
      players,
      perView: {
        draws: perView.draws,
        triangles: perView.triangles,
        vertices: perView.vertices,
        indexBytes: perView.indexBytes,
        drawUniformBytes: perView.drawUniformBytes,
        viewUniformBytes: perView.viewUniformBytes
      },
      frame: {
        draws: frame.draws,
        triangles: frame.triangles,
        vertices: frame.vertices,
        indexBytes: frame.indexBytes,
        uniformBytesOptionA: frame.uniformBytesOptionA,
        uniformBytesOptionB: frame.uniformBytesOptionB
      },
      texture: textureMemory(mapId, players, { distinctCars: true }),
      textureSameCar: textureMemory(mapId, players, { distinctCars: false }),
      geometry: geometryMemory(mapId, players, { distinctCars: true }),
      geometrySameCar: geometryMemory(mapId, players, { distinctCars: false }),
      linearViewMs: {
        p50: round(linearViewMs(players, 'p50')),
        p95: round(linearViewMs(players, 'p95')),
        max: round(linearViewMs(players, 'max'))
      },
      drawBoundMs: round(drawBoundMs(mapId, players)),
      lod: {
        remoteCarDraws: REMOTE_LOD_DRAWS,
        perViewDraws: lodPerViewDraws(mapId, players),
        frameDraws: lodFrameDraws(mapId, players),
        drawBoundMs: round(drawBoundForDraws(lodFrameDraws(mapId, players)))
      }
    });
  }
  return rows;
}

/** Worst-case roster car envelope: 123 draws / 41,270 tri / 40,018 verts. */
function sensitivityFor(mapId) {
  return [2, 4].map((players) => {
    const perView = perViewWork(mapId, players, CAR_ENVELOPE);
    const frame = frameWork(mapId, players, CAR_ENVELOPE);
    const lodPerView = lodPerViewDraws(mapId, players, CAR_ENVELOPE);
    const lodFrame = lodFrameDraws(mapId, players, CAR_ENVELOPE);
    return {
      players,
      perViewDraws: perView.draws,
      frameDraws: frame.draws,
      drawBoundMs: round(drawBoundMs(mapId, players, CAR_ENVELOPE)),
      lodPerViewDraws: lodPerView,
      lodFrameDraws: lodFrame,
      lodDrawBoundMs: round(drawBoundForDraws(lodFrame))
    };
  });
}

function verdictFor(mapId) {
  const rows = [];
  for (const hz of [60, 30]) {
    for (const players of PLAYER_COUNTS) {
      const entry = feasibility(mapId, players, hz, 'p95');
      const lodDraws = lodFrameDraws(mapId, players);
      const lodDrawMs = drawBoundForDraws(lodDraws);
      const lodLinear = linearViewMs(players, 'p95');
      const lodStatus = lodLinear > entry.budgetMs ? 'infeasible'
        : lodDrawMs > entry.budgetMs ? 'marginal-linear-only'
          : MAPS[mapId].measured ? 'feasible' : 'estimate-fits-unmeasured';
      rows.push({
        hz,
        players,
        status: entry.status,
        measured: entry.measured,
        budgetMs: round(entry.budgetMs),
        linearViewMs: round(entry.linearViewMs),
        drawBoundMs: round(entry.drawBoundMs),
        linearUtilization: round(entry.linearUtilization, 4),
        drawUtilization: round(entry.drawUtilization, 4),
        marginLinearMs: round(entry.marginLinearMs),
        marginDrawMs: round(entry.marginDrawMs),
        withRemoteLod: {
          frameDraws: lodDraws,
          drawBoundMs: round(lodDrawMs),
          status: lodStatus
        }
      });
    }
  }
  return rows;
}

function lodStatus(mapId, players, hz, car) {
  const budget = frameBudgetMs(hz);
  const linear = linearViewMs(players, 'p95');
  const draw = drawBoundForDraws(lodFrameDraws(mapId, players, car));
  if (linear > budget) return 'infeasible';
  if (draw > budget) return 'marginal-linear-only';
  return MAPS[mapId].measured ? 'feasible' : 'estimate-fits-unmeasured';
}

function maxPlayers(rows, hz, key = 'status', value = 'feasible') {
  const eligible = rows.filter((row) => row.hz === hz && row[key] === value);
  return eligible.length === 0 ? 0 : Math.max(...eligible.map((row) => row.players));
}

export function buildPlan() {
  const maps = {};
  const verdicts = {};
  for (const mapId of MAP_IDS) {
    maps[mapId] = {
      label: MAPS[mapId].label,
      static: {
        draws: MAPS[mapId].draws,
        triangles: MAPS[mapId].triangles,
        vertices: MAPS[mapId].vertices,
        indices: MAPS[mapId].indices,
        textures: MAPS[mapId].textures,
        textureBytes: MAPS[mapId].textureBytes
      },
      evidence: MAPS[mapId].evidence,
      rows: tableFor(mapId),
      carEnvelope: CAR_ENVELOPE,
      sensitivity: sensitivityFor(mapId)
    };
    verdicts[mapId] = verdictFor(mapId);
  }

  const riverRows = verdicts.river;
  const maxFeasible60 = maxPlayers(riverRows, 60);
  const maxFeasible30 = maxPlayers(riverRows, 30);
  const maxLod30 = Math.max(...riverRows
    .filter((row) => row.hz === 30 && row.withRemoteLod.status === 'feasible')
    .map((row) => row.players));

  const plan = {
    kind: 'split-screen.plan',
    version: 1,
    date: '2026-11-08',
    status: 'design',
    scope: '1-4 local players, single browser tab, WebGPU backend, shared scene',
    canvas: CANVAS,
    fovPolicy: FOV_POLICY,
    source: {
      frameAnchor: FRAME_ANCHOR,
      car: CAR,
      maps: Object.fromEntries(MAP_IDS.map((id) => [id, {
        label: MAPS[id].label,
        evidence: MAPS[id].evidence
      }])),
      hardware: {
        adapter: 'nvidia / blackwell',
        browser: 'headless Edge WebGPU',
        viewport: '1600x900, devicePixelRatio 1',
        note: 'The frame anchor is the only measured frame time. Amboy, Gracia and Longbeach have no measured frame time.'
      }
    },
    budgets: {
      hz60: {
        frameMs: round(frameBudgetMs(60)),
        verdictBasis: 'p95 of the measured one-view frame (6.975 ms), linear-view and draw-bound must both fit',
        playersFeasible: maxFeasible60,
        playersFeasibleEnvelope: 1,
        note: '2P requires <=100 draws per car; the 123-draw envelope is marginal at 60 Hz and needs remote LOD.'
      },
      hz30: {
        frameMs: round(frameBudgetMs(30)),
        verdictBasis: 'same bounds at 30 Hz',
        playersFeasible: maxFeasible30,
        playersFeasibleEnvelope: 3,
        playersFeasibleWithRemoteLod: maxLod30,
        note: '4P needs the 12-draw remote-car LOD; it also fits with the 123-draw envelope.'
      }
    },
    model: {
      linearView: {
        id: 'linear-view-upper-bound',
        oneViewMs: { p50: oneViewMs('p50'), p95: oneViewMs('p95'), max: oneViewMs('max') },
        formula: 'T(N) <= N * oneViewMs',
        note: 'Each view is at most one measured full frame; this ignores the extra car draws a view gains.'
      },
      drawBound: {
        id: 'draw-proportional-upper-estimate',
        perDrawMs: round(perDrawMs(), 8),
        anchor: FRAME_ANCHOR.frameMs.p50 + ' ms / ' + FRAME_ANCHOR.drawsPerFrame + ' draws',
        formula: 'T(N) = frameDraws(N) * perDrawMs',
        note: 'Charges the whole measured frame interval to every draw; deliberately over-charges and is not a measurement of another map.'
      },
      cpu: {
        measuredWorkMs: FRAME_ANCHOR.workMs,
        measuredTicksPerFrame: FRAME_ANCHOR.ticksPerFrame,
        boundFourPlayers: '4 x measured work per frame (over-charges 4 one-tick cars as 16 ticks)',
        fourPlayerMs: {
          p50: round(4 * FRAME_ANCHOR.workMs.p50),
          p95: round(4 * FRAME_ANCHOR.workMs.p95),
          max: round(4 * FRAME_ANCHOR.workMs.max)
        },
        wasmBytesPerInstance: 268435456,
        wasmBytesFourInstances: 4 * 268435456,
        note: 'The current wasm module has one car world per instance; the AI path already runs one instance per simulated car.'
      }
    },
    layouts: LAYOUTS,
    maps,
    verdict: {
      measuredMap: 'river',
      maxPlayers60Hz: maxFeasible60,
      maxPlayers30Hz: maxFeasible30,
      maxPlayers30HzWithRemoteLod: maxLod30,
      carSensitivity: {
        note: 'Reference 100-draw Corvette versus the 123-draw roster envelope; the envelope is a conservative mixed-car upper bound, not one car.',
        reference: CAR,
        envelope: CAR_ENVELOPE,
        river2p60: {
          reference: feasibility('river', 2, 60).status,
          envelope: feasibility('river', 2, 60, 'p95', CAR_ENVELOPE).status,
          envelopeDrawBoundMs: round(drawBoundMs('river', 2, CAR_ENVELOPE)),
          envelopeWithRemoteLod: lodStatus('river', 2, 60, CAR_ENVELOPE),
          envelopeWithRemoteLodDrawBoundMs: round(drawBoundForDraws(lodFrameDraws('river', 2, CAR_ENVELOPE)))
        },
        river4p30: {
          reference: feasibility('river', 4, 30).status,
          envelope: feasibility('river', 4, 30, 'p95', CAR_ENVELOPE).status,
          envelopeDrawBoundMs: round(drawBoundMs('river', 4, CAR_ENVELOPE)),
          envelopeWithRemoteLod: lodStatus('river', 4, 30, CAR_ENVELOPE),
          envelopeWithRemoteLodDrawBoundMs: round(drawBoundForDraws(lodFrameDraws('river', 4, CAR_ENVELOPE)))
        }
      },
      byMap: verdicts,
      headline: {
        hz60: '2 players on River with the 100-draw reference car (measured bound); the 123-draw envelope is marginal at 60 Hz without remote LOD. 3-4 not feasible. Amboy/Gracia/Longbeach not certified.',
        hz30: '3 players full-draw; 4 players with the proposed 12-draw remote-car LOD on River, including the 123-draw envelope. Big maps need batching and a measurement.',
        fallback: '30 Hz target, remote-car LOD, per-view frustum culling, or per-view resolution scale; resolution scale only helps a fill-bound frame.'
      }
    },
    passes: {
      colorPasses: 1,
      viewportStages: 'players',
      colorClears: 1,
      depthClears: 1,
      shadowPasses: 0,
      postPasses: 0,
      occlusionCastsPerTick: 'players',
      occlusionQueryPasses: 0,
      queueSubmits: 1,
      uniformWritesPerFrame: 1,
      note: 'One beginRenderPass with N setViewport/setScissorRect stages. A per-view loadOp:clear would clear earlier views; per-view depth clear has the same problem. The current consumer has no shadow, post or GPU occlusion pass.'
    },
    integration: {
      packet: {
        version: '1.2 (views optional; v1.1 remains valid)',
        add: 'views: [{ playerId, camera }] while camera stays player 1 for compatibility',
        keep: 'draws is one shared list containing every player car; no per-view draw list'
      },
      consumer: [
        'renderFrame({ cursor, views }) with views defaulting to [{ rect: fullCanvas, camera: frame.camera }]',
        'extend the draw uniform buffer to viewCount x drawCount x 256 B (option A) or split view constants from draw constants (option B)',
        'begin one render pass with one color/depth clear, then setViewport/setScissorRect per view and re-issue the shared draw list',
        'repeat ghost and power-up draw groups per view with that view uniform offset',
        'clamp every device rect to the canvas and reject a zero/negative size',
        'report drawsIssued = views x draws and per-view counters',
        'HUD stays DOM and receives the same CSS rects; no canvas UI pass'
      ],
      adapter: [
        'appendPlayers([{ state, car }]) instead of appendState for the local session',
        'one ChaseCamera per player, sharing the same occluder BVH',
        'one car node prefix per player (p1..p4) in the packet node table'
      ]
    },
    input: {
      players: [
        { player: 1, primary: 'keyboard (WASD/arrows, Space handbrake)', alternate: 'gamepad 0', notes: 'keyboard and gamepad 0 are the same logical player; gamepad wins while any pad input is active' },
        { player: 2, primary: 'gamepad 1', alternate: 'none', notes: 'the keyboard cannot drive a second player' },
        { player: 3, primary: 'gamepad 2', alternate: 'none', notes: '' },
        { player: 4, primary: 'gamepad 3', alternate: 'none', notes: '' }
      ],
      gamepad: {
        api: 'navigator.getGamepads(), polled once per animation frame',
        steer: 'left stick X, deadzone 0.15, digital sign for the first slice',
        throttle: 'right trigger',
        brake: 'left trigger',
        handbrake: 'A / Cross',
        powerup: 'X / Square',
        pause: 'Start / Options',
        assignment: 'connection order: pad index 0 -> P1, 1 -> P2, 2 -> P3, 3 -> P4',
        disconnect: 'that player input is lost and the car coasts; no silent reassignment'
      },
      minimum: {
        '2p': 'keyboard + one gamepad (or two gamepads)',
        '3p': 'three gamepads',
        '4p': 'four gamepads'
      }
    },
    ownership: {
      model: 'host-authoritative, local peers in one process',
      host: {
        player: 1,
        owns: ['simulation of every car', 'race state and gates', 'power-up state', 'results', 'pause'],
        wasm: 'one wasm instance per car (current module has one global world); 4 instances = 1,073,741,824 B heap'
      },
      peers: [
        { player: 2, owns: ['input intent', 'camera preferences', 'HUD'], authority: 'none' },
        { player: 3, owns: ['input intent', 'camera preferences', 'HUD'], authority: 'none' },
        { player: 4, owns: ['input intent', 'camera preferences', 'HUD'], authority: 'none' }
      ],
      snapshot: {
        rateHz: 60,
        transport: 'in-process call (no WebSocket)',
        content: 'each car pose, race row, power-up state',
        correction: 'none required at 60 Hz; reuse RemoteDisplay blending only if a peer view is decoupled',
        determinism: 'per-car state hash plus a session hash for the 4-car local run'
      },
      pause: 'host applies pause; any player may request it; a disconnected pad pauses that player input only'
    },
    hud: {
      placement: {
        speed: 'bottom-left of the player viewport',
        lapPosition: 'top-left of the player viewport',
        powerupSlot: 'bottom-right of the player viewport',
        healthShield: 'directly above the power-up slot',
        divider: 'CSS 2 px line on the split edge; never drawn by the renderer'
      },
      scale: Object.fromEntries(LAYOUTS.map((layout) => [layout.id, layout.hudScale])),
      playerAccent: ['cyan', 'orange', 'green', 'magenta'],
      note: 'DOM overlay positioned from the same view rects; no per-view canvas UI and no HUD in the packet.'
    },
    limits: [
      'Only River has a measured frame time; Amboy, Gracia and Longbeach per-view times are estimates, not claims.',
      'The measured frame interval is a headless rAF cadence (~144 Hz), not a GPU timestamp; it is an upper bound on one view.',
      'The wasm module has one car per instance: 4 local players need 4 instances and ~1 GiB of wasm heap.',
      'Keyboard can drive only one local player; 3-4 players need 3-4 gamepads.',
      'No shadow, post-process or GPU occlusion pass exists today; adding per-view shadows or post would multiply passes.',
      'Per-view frustum culling and remote-car LOD are proposed levers, not implemented code.',
      'No browser capture or split-screen build was run for this design; no visual or frame-rate claim is made.'
    ],
    planHash: null
  };

  plan.planHash = planHash(plan);
  return plan;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const plan = buildPlan();
  mkdirSync(dirname(PLAN_PATH), { recursive: true });
  writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  console.log('wrote ' + PLAN_PATH);
  console.log('planHash ' + plan.planHash);
  console.log('layouts ' + plan.layouts.length + ' maps ' + MAP_IDS.length + ' verdict rows ' +
    Object.values(plan.verdict.byMap).reduce((sum, rows) => sum + rows.length, 0));
  console.log('60 Hz max players (River) ' + plan.verdict.maxPlayers60Hz);
  console.log('30 Hz max players (River) ' + plan.verdict.maxPlayers30Hz + ' / with LOD ' + plan.verdict.maxPlayers30HzWithRemoteLod);
}
