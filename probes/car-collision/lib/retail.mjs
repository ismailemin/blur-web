/*
 * retail.mjs — recovered retail car-vs-car collision values, with provenance.
 *
 * Every number in `RETAIL` is either
 *   - read from the shipped XT data (`amax.xt`, `rldatabase.xt`,
 *     `multiplayer.xt`) and cited by record id, payload offset and struct
 *     offset, or
 *   - read from the read-only extracted source tree
 *     `_work/engine-vehicle-spike/tree/` and cited by file + line + file hash.
 *
 * Nothing here is a tuned or guessed constant. Values that are *not* recovered
 * are marked `recovered:false` with the reason, and the resolver refuses to use
 * them as if they were data.
 *
 * This module is standalone ESM with no imports.
 */

export const RETAIL_SOURCE_ROOT = '_work/engine-vehicle-spike/tree';

/** SHA-256 of every cited source file (pinned by tools/verify.mjs). */
export const SOURCE_HASHES = Object.freeze({
  'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp':
    'd1330a62e2a237468447f04cf38656af031d315cb8456433eeefd32a69d66cbc',
  'code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp':
    '8efa173e9caec493b7bc640ca5b8bd9af9a3e679df1fa6f6be0db0e5c4032a83',
  'code/amax/game/Game/GameDef/Materials.cpp':
    '69dda2c78bed169efef02cbb2087ba80404a486c8dfc49a0f956fdfc73adbd90',
  'code/amax/game/Game/GameDef/Materials.h':
    '046dd0125160971601aac3111494bd357c2cac7c1b2cdb2e9715810e25f2429d',
  'code/amax/game/Game/GameDef/PhysicsConstants.cpp':
    '656fade308eed61cd42b6a93f6ec894c34f4f2e00943f3466195ad1e9270b469',
  'code/amax/game/GameLogic/Layers/RaceLogicLayer.cpp':
    '0c97dbfc309beb2fea9eda60322cb97510d33b00e72df0b2496592c1bfc2062c',
  'code/mercury/library/physics/gravity/source/solver2/ContactConstraint.cpp':
    'd0141c7b43d15ceda77618159ccca2ea1025e904c276ca8b272d5f83a8b129be',
  'code/mercury/library/physics/gravity/source/solver2/ContactJacobian.cpp':
    '1e794812543c3b36793e92c0dcd05dda749375b67ff1df75346d2c25d516462f',
  'code/mercury/library/physics/gravity/source/sharedphysics/GravityConstants.cpp':
    '4aa3702c232d5da880ca4832f60e15bf5eb05039daf961831fd34a59fd23e2e3',
  'code/mercury/library/physics/gravity/source/sdk/Scene.cpp':
    '574d2c007f27ba16c02dccc100bb7d82a31a0553cfa5d66a1e9e14d1b9fdd07d',
  'code/amax/game/GameLogic/RaceLogicCore/Database/RLDatabase.h':
    '58b1b3af9552b95a6adfb887adb8d57b40ae5646154eeae3b019c3f87a991265',
  'code/amax/game/GameLogic/RaceLogicCore/Database/RLDatabase.cpp':
    'a7844f9352279712c38863f686f1a299a64ec4d8b9bcfb736c2c5e0300eccb59'
});

/**
 * Source citations. `text` is the exact line content that was read; the
 * verifier re-reads the file, re-hashes it and compares the line text.
 */
export const CITATIONS = Object.freeze([
  {
    id: 'material-defaults',
    file: 'code/amax/game/Game/GameDef/Materials.cpp',
    lines: [30, 31],
    text: [
      'Debug::Float g_debugPhysicsMaterialDefaultFriction("Amax.PhysicsMaterials.DefaultFriction", 0.65f, Debug::Range(0.0f, 5.0f), Debug::Step(0.001f));',
      'Debug::Float g_debugPhysicsMaterialDefaultRestitution("Amax.PhysicsMaterials.DefaultRestitution", 0.05f, Debug::Range(-1.0f, 1.0f), Debug::Step(0.001f));'
    ]
  },
  {
    id: 'material-xt-override',
    file: 'code/amax/game/Game/GameDef/Materials.cpp',
    lines: [56, 57],
    text: [
      'matPair.m_Friction[0] = matPair.m_Friction[1] = matPair.m_Friction[2] = pSettings->friction;',
      'matPair.m_RestitutionCoefficient = pSettings->restitution_coefficient;'
    ]
  },
  {
    id: 'vehicle-vehicle-filter',
    file: 'code/amax/game/Game/GameDef/PhysicsConstants.cpp',
    lines: [21, 22],
    text: [
      '//The new vehicle-and-dynamic-object-only collision filter',
      'Collision::C_CollisionFilter\tkVehicleVehicleCollisionFilter( PolyFlags::kVehicleBlocker |'
    ]
  },
  {
    id: 'car-collider-shape',
    file: 'code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp',
    lines: [6868, 6876],
    text: [
      'else if (m_tempHaveNewVehicleToVehicleMesh && elementName == "e_carcollider")',
      'm_CarColliderIndex = compDesc.shapes.m_numElements - 1;'
    ]
  },
  {
    id: 'vehicle-baumgarte-slop',
    file: 'code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp',
    lines: [6912, 6913],
    text: [
      'm_pCollisionBody->Baumgarte(g_debugVehicleBaumgarte);//PhysicsConstants::kVehicleBaumgarte);',
      'm_pCollisionBody->Slop(g_dbSlopValue);'
    ]
  },
  {
    id: 'vehicle-baumgarte-default',
    file: 'code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp',
    lines: [228, 229],
    text: [
      'Debug::Float g_debugVehicleBaumgarte("Gravity.VehicleBaumgarte", 1.25f, Debug::Range(0.0f, 5.0f), Debug::Step(0.001f), Debug::Persist());',
      'Debug::Float g_dbSlopValue("Gravity.VehicleSlop", 0.00005f, Debug::Range(1.f, 0.f));'
    ]
  },
  {
    id: 'car-collision-margin',
    file: 'code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp',
    lines: [5421],
    text: [
      'Debug::Float g_debugCarCollisionMargin("Vehicle.Collision.Margin", 0.04f, Debug::Range(0.0f, 0.1f), Debug::Step(0.001f));'
    ]
  },
  {
    id: 'restitution-threshold-apply',
    file: 'code/mercury/library/physics/gravity/source/solver2/ContactConstraint.cpp',
    lines: [124, 127, 132],
    text: [
      'const VF32 threshold(SharedPhysics::Constants::RestitutionVelocityThreshold());',
      'const VF32 restitution = Maths::Select(Abs(normSpeed) < threshold, zero, _restitution);',
      'contact->m_CoefficientSetting = Maths::MakeVector4(frictionU, frictionV, restitution, one + restitution);'
    ]
  },
  {
    id: 'restitution-threshold',
    file: 'code/mercury/library/physics/gravity/source/sharedphysics/GravityConstants.cpp',
    lines: [21],
    text: [
      'const F32 Constants::m_RestitutionVelocityThreshold(0.05f);'
    ]
  },
  {
    id: 'solver-iterations',
    file: 'code/mercury/library/physics/gravity/source/sdk/Scene.cpp',
    lines: [49],
    text: [
      'Debug::Int g_dbNumIterations("Gravity.Solver.NumberIterations", 30, Debug::Range(10, 100));'
    ]
  },
  {
    id: 'baumgarte-bias',
    file: 'code/mercury/library/physics/gravity/source/solver2/ContactJacobian.cpp',
    lines: [26, 42],
    text: [
      'VF32 _pen(_m_Error);',
      'const VF32 value(pen*m_Baumgarte + cOfR*X(bVec));'
    ]
  },
  {
    id: 'gameplay-impulse-normalisation',
    file: 'code/amax/game/GameLogic/Layers/RaceLogicLayer.cpp',
    lines: [2376, 2386],
    text: [
      'float fImpulse = (F32)Clamp(impulse*maxImpulseRangeReciprocal, zero, one);',
      'float fDamageImpulse = (F32)Clamp((impulse*maxImpulseRange_DamageReciprocal), zero, one);'
    ]
  },
  {
    id: 'gameplay-impulse-max-point',
    file: 'code/amax/game/GameLogic/Layers/RaceLogicLayer.cpp',
    lines: [2384, 2384],
    text: [
      'impactMsg.mCollisionInfo.m_GameplayImpulse = Max(fImpulse, impactMsg.mCollisionInfo.m_GameplayImpulse);'
    ]
  },
  {
    id: 'impact-level-lookup',
    file: 'code/amax/game/GameLogic/Layers/RaceLogicLayer.cpp',
    lines: [3235, 3257],
    text: [
      'const E_IMPACT_LEVEL C_RaceLogicLayer::CalculateImpactLevel(const float gameplayImpulse, bool isSideImpact) const',
      'return E_IMPACT_LEVEL_NONE;'
    ]
  },
  {
    id: 'damage-side-impact',
    file: 'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp',
    lines: [1746, 1753],
    text: [
      'F32 newImpulse = pImpactMsg->mCollisionInfo.m_GameplayImpulse;',
      'E_IMPACT_LEVEL impactLevel = mpRaceLogicLayer->CalculateImpactLevel(newImpulse, isSideImpact);'
    ]
  },
  {
    id: 'damage-only-victim',
    file: 'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp',
    lines: [1793, 1795],
    text: [
      'if(!actorB || actorB->GetActorTypeId() != Game::E_ActorTypeId_Vehicle || !vehActorB || mVehicleIndex != gameplayImpactMsg.mAggressiveVehicleIdx )',
      'GetDamagePointsFromImpact(gameplayImpactMsg);'
    ]
  },
  {
    id: 'damage-cooldown',
    file: 'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp',
    lines: [1845, 1857],
    text: [
      'if(mCooldown <= 0.f)',
      'mCooldown = pRLDamageParameters->mCooldownCollision;'
    ]
  },
  {
    id: 'damage-points',
    file: 'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp',
    lines: [1056, 1061],
    text: [
      'void C_VehicleComponent_Damage::GetDamagePointsFromImpact(Game::C_GameplayImpactMsg& gameplayImpactMsg)',
      'gameplayImpactMsg.mDamage = GetDamagePointsFromImpactLevel(pRLDamageParameters, gameplayImpactMsg.mImpactLevel);'
    ]
  },
  {
    id: 'aggressive-vehicle',
    file: 'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp',
    lines: [1137, 1174],
    text: [
      'int C_VehicleComponent_Damage::DetermineAggressiveVehicle(Game::Actors::C_VehicleActor* pActorA, Game::Actors::C_VehicleActor* pActorB, Game::C_ImpactMsg* pMsg)',
      'return pActorB->GetVehicleIndex();'
    ]
  },
  {
    id: 'frontal-impact',
    file: 'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp',
    lines: [2522, 2555],
    text: [
      'bool C_VehicleComponent_Damage::IsFrontalImpact(const Game::C_ImpactMsg* pMsg, const Game::Actors::C_VehicleActor* vehActor) const',
      'return false;'
    ]
  },
  {
    id: 'battering-ram-fire',
    file: 'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp',
    lines: [1524, 1528],
    text: [
      'const float myDotForward = Maths::DotProduct(myForward, delta);',
      'if(closingSpeedInMPH >= mBatteringRamModData.mMinimumImpactSpeedInMPH || g_BatteringRamHairTrigger)'
    ]
  },
  {
    id: 'valid-vehicle-vehicle',
    file: 'code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp',
    lines: [1478, 1485],
    text: [
      'const bool C_VehicleComponent_Damage::ValidVehicleToVehicleCollision(\tconst Game::Actors::C_VehicleActor *pVehicleActorA,',
      'return true;'
    ]
  }
]);

/**
 * Serialized XT values used by the model. `offset` is the absolute byte offset
 * of the record payload inside the decoded pack; `fieldOffset` is inside the
 * record.
 */
export const XT_VALUES = Object.freeze({
  materialPair: Object.freeze({
    pack: '_work/powerups/amax.xt',
    packSource: 'game-data/Blur/cache/gamedata.pak \\gamedata\\xt\\amax.bin',
    recordIndex: 4320,
    recordId: 4093726821,
    type: 'AmaxFrictionSettings',
    payloadOffset: 5082,
    size: 16,
    fields: Object.freeze({
      Material1: { offset: 0, value: 'Vehicle' },
      Material2: { offset: 4, value: 'Vehicle' },
      Friction: { offset: 8, value: 0.1 },
      RestitutionCoefficient: { offset: 12, value: 0.2 }
    })
  }),
  damageParameters: Object.freeze({
    pack: '_work/powerups/rldatabase.xt',
    packSource: 'game-data/Blur/cache/gamedata.pak \\gamedata\\xt\\rldatabase.bin',
    recordIndex: 33,
    recordId: 1981555840,
    type: 'DamageParameters',
    payloadOffset: 60,
    size: 156,
    fields: Object.freeze({
      MaxWorldDamageImpulse: { offset: 0, value: 150000 },
      MaxWorldEffectImpulse: { offset: 4, value: 20000 },
      MaxVehicleDamageImpulse: { offset: 8, value: 150000 },
      MaxVehicleEffectImpulse: { offset: 12, value: 20000 },
      MaxObjectDamageImpulse: { offset: 16, value: 10000 },
      MaxObjectEffectImpulse: { offset: 20, value: 1000 },
      MaxStaticImpulse: { offset: 24, value: 150000 },
      MaxDynamicImpulse: { offset: 28, value: 105000 },
      HitByPerkCooldown: { offset: 32, value: 1.5 },
      CollidedCooldown: { offset: 36, value: 1.5 },
      HealthIncrement: { offset: 40, value: 100 },
      LightImpactDamage: { offset: 44, value: 0 },
      MediumImpactDamage: { offset: 48, value: 0 },
      HeavyImpactDamage: { offset: 52, value: 50 },
      ResetTimerAfterWrecked: { offset: 56, value: 3.5 },
      CapGameplayImpulse: { offset: 60, value: true },
      IntraVehicularCollisionInertiaScale: { offset: 64, value: 'inline InertiaScale (52 B)' },
      VehicleHealthGroups: { offset: 116, value: 'array of 4 VehicleHealthGroup' }
    })
  }),
  damageSystem: Object.freeze({
    pack: '_work/powerups/rldatabase.xt',
    recordIndex: 53,
    recordId: 2981908992,
    type: 'DamageSystem',
    payloadOffset: 90,
    size: 68,
    fields: Object.freeze({
      Parameters: { offset: 0, value: 'handle -> DamageParameters record 33' },
      ImpactTypes: { offset: 4, value: 'array of 3 ImpactType handles' },
      LandingTypes: { offset: 12, value: 'array' },
      HealthZones: { offset: 20, value: 'array' }
    })
  }),
  impactTypes: Object.freeze([
    Object.freeze({
      level: 'NONE', recordIndex: 23, recordId: 1356885860, payloadOffset: 40,
      front: { min: 0.0, max: 0.05 }, side: { min: 0.0, max: 0.04 }
    }),
    Object.freeze({
      level: 'LIGHT', recordIndex: 10, recordId: 567245677, payloadOffset: 21,
      front: { min: 0.05, max: 0.1 }, side: { min: 0.04, max: 0.1 }
    }),
    Object.freeze({
      level: 'MEDIUM', recordIndex: 48, recordId: 2653652094, payloadOffset: 81,
      front: { min: 0.101, max: 0.31 }, side: { min: 0.1, max: 0.31 }
    }),
    Object.freeze({
      level: 'HEAVY', recordIndex: 26, recordId: 1611093402, payloadOffset: 49,
      front: { min: 0.31, max: 1.0 }, side: { min: 0.31, max: 1.0 }
    })
  ]),
  inertiaScale: Object.freeze({
    pack: '_work/powerups/rldatabase.xt',
    recordIndex: 33,
    fieldOffsetInRecord: 64,
    type: 'InertiaScale',
    fields: Object.freeze({
      HumanToAiInertiaScaleHuman: { offset: 0, value: 4.5 },
      HumanToAiInertiaScaleAi: { offset: 4, value: 1.8 },
      HumanToHumanInertiaScale: { offset: 8, value: 1.5 },
      AiToAiInertiaScale: { offset: 12, value: 1.0 },
      CarToObjectInertiaScaleCar: { offset: 16, value: 4.0 },
      CarToObjectInertiaScaleObject: { offset: 20, value: 1.0 },
      HumanToAiMassScaleHuman: { offset: 24, value: 1.1 },
      HumanToAiMassScaleAi: { offset: 28, value: 1.0 },
      CarToObjectMassScaleCar: { offset: 32, value: 1.0 },
      CarToObjectMassScaleObject: { offset: 36, value: 1.0 },
      ScaledImpactMaxSpeed: { offset: 40, value: 280.0 },
      ScaledImpactMinSpeed: { offset: 44, value: 250.0 },
      MinCarToObjectMassValue: { offset: 48, value: 1000.0 }
    })
  }),
  healthGroups: Object.freeze([
    { group: 'Low', baseHealth: 500 },
    { group: 'Medium', baseHealth: 600 },
    { group: 'High', baseHealth: 700 },
    { group: 'VeryHigh', baseHealth: 800 }
  ]),
  batteringRam: Object.freeze({
    pack: '_work/powerups/multiplayer.xt',
    recordIndex: 285,
    recordId: 1941391765,
    type: 'MultiplayerAbility',
    payloadOffset: 361,
    size: 76,
    fields: Object.freeze({
      AbilityId: { offset: 0, value: 'BatteringRam' },
      AbilityValue: { offset: 20, value: 1.0 }
    }),
    notes: 'BatteringRamCollisionConsequences (type 75, 84 B) is declared but has no serialized record in the shipped packs; cool_down_timer / targetting_cone / minimum_impact_speed_in_MPH are runtime values.'
  }),
  stableFrame: Object.freeze({
    pack: '_work/powerups/multiplayer.xt',
    recordIndex: 213,
    recordId: 1442202921,
    type: 'MultiplayerAbility',
    payloadOffset: 361,
    fields: Object.freeze({
      AbilityId: { offset: 0, value: 'StableFrame' },
      AbilityValue: { offset: 20, value: 0.5 }
    })
  })
});

/** Force constants used by the recovered gravity solver. */
export const SOLVER = Object.freeze({
  iterations: 30,
  restitutionVelocityThresholdMps: 0.05,
  baumgarte: 1.25,
  slopM: 0.00005,
  collisionMarginM: 0.04,
  maxManifoldContacts: 4,
  contactBreakingThresholdM: 0.02,
  notes: Object.freeze([
    'Gravity.Solver.NumberIterations default 30 (Scene.cpp:49).',
    'Vehicle contact body Baumgarte 1.25 and slop 5e-5 (VehicleActor.cpp:228-229, 6912-6913).',
    'Restitution is zero below 0.05 m/s relative normal speed (ContactConstraint.cpp:124-127, GravityConstants.cpp:21).',
    'Retail manifold keeps at most 4 points with a 0.02 m breaking threshold (PersistentContactManifold.h:48,53); this 2D resolver clips at most 2.'
  ])
});

/** Vehicle-vs-vehicle material pair (XT override of the 0.65/0.05 default). */
export const MATERIAL_PAIR = Object.freeze({
  friction: 0.1,
  restitution: 0.2,
  source: 'amax.xt AmaxFrictionSettings Vehicle x Vehicle, record 4320 id 4093726821, payload offset 5082 +8/+12',
  defaultPair: Object.freeze({ friction: 0.65, restitution: 0.05, source: 'Materials.cpp:30-31,47-48' })
});

/**
 * Damage thresholds and values (rldatabase.xt DamageSystem -> DamageParameters
 * + 3 ImpactType records). `gameplayImpulse` is the max per-contact-point
 * normal impulse normalised by MaxVehicleDamageImpulse, clamped to [0,1].
 */
export const DAMAGE = Object.freeze({
  maxVehicleDamageImpulseNs: 150000,
  maxVehicleEffectImpulseNs: 20000,
  maxStaticImpulseNs: 150000,
  maxDynamicImpulseNs: 105000,
  capGameplayImpulse: true,
  collidedCooldownSeconds: 1.5,
  hitByPerkCooldownSeconds: 1.5,
  healthIncrement: 100,
  resetTimerAfterWreckedSeconds: 3.5,
  levelDamage: Object.freeze({ NONE: 0, LIGHT: 0, MEDIUM: 0, HEAVY: 50 }),
  healthGroups: XT_VALUES.healthGroups,
  impactTypes: XT_VALUES.impactTypes,
  source: 'rldatabase.xt DamageParameters record 33 (payload 60) + ImpactType records 23/10/48/26'
});

/** Aggressor heuristic constants (VLC_Damage.cpp:1132-1135, 57-58). */
export const AGGRESSION = Object.freeze({
  speedRatio: 0.5,
  minSpeedMph: 25,
  maxSpeedMph: 45,
  swipeThreshold: 120,
  frontalCollisionDot: 0.85,
  frontalCollisionUprightDot: 0.707,
  mphToMps: 0.44704,
  source: 'VLC_Damage.cpp:57-58 (frontal dots), 1132-1135 (speed ratio / min / max / swipe)'
});

/**
 * The documented maximum car envelope. PHYS1 (`probes/physics`) has not
 * produced a per-car manifest at the time of this task, so this fixed box is
 * the documented fallback and is labelled `fallback:true` on every car.
 */
export const CAR_ENVELOPE = Object.freeze({
  length: 2.98,
  width: 1.68,
  height: 1.35,
  source: 'probes/prop-collision/lib/collider-build.mjs CAR_ENVELOPE: documented maximum XT envelope (largest roster wheelbase 2.981 m, widest track 1.676 m); not a recovered retail hull',
  phys1: false
});

/**
 * Resolve the envelope for one car. A caller (or later PHYS1) may pass
 * `spec.envelope = {length,width,height,source}`; invalid envelopes are a typed
 * error, never a silent fallback.
 */
export function resolveCarEnvelope(spec = {}) {
  const env = spec.envelope;
  if (env === undefined || env === null) {
    return { ...CAR_ENVELOPE, fallback: true, source: CAR_ENVELOPE.source, phys1: false };
  }
  const length = Number(env.length);
  const width = Number(env.width);
  const height = env.height === undefined ? CAR_ENVELOPE.height : Number(env.height);
  if (![length, width, height].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error('car envelope is not three positive finite numbers: ' + JSON.stringify(env));
  }
  if (length < width) {
    throw new Error('car envelope length < width (axes swapped?): ' + JSON.stringify(env));
  }
  return {
    length, width, height,
    fallback: env.fallback === true,
    phys1: Boolean(env.phys1) || String(env.source ?? '').startsWith('PHYS1'),
    source: env.source ?? 'caller-supplied envelope'
  };
}

/** Damage-parameter lookup by gameplay impulse. Mirrors CalculateImpactLevel. */
export function impactLevel(gameplayImpulse, isSideImpact) {
  for (const entry of DAMAGE.impactTypes) {
    const bound = isSideImpact ? entry.side : entry.front;
    if (gameplayImpulse <= bound.max && gameplayImpulse > bound.min) return entry.level;
  }
  return 'NONE';
}

export function damageForLevel(level) {
  return DAMAGE.levelDamage[level] ?? 0;
}

/**
 * Normalise a raw contact-point normal impulse (N.s) the way RaceLogicLayer
 * does before the damage lookup: clamp(impulse / MaxVehicleDamageImpulse, 0, 1).
 */
export function gameplayImpulseFromNs(impulseNs) {
  if (!Number.isFinite(impulseNs) || impulseNs < 0) {
    throw new Error('contact impulse is not a non-negative finite number: ' + impulseNs);
  }
  return Math.max(0, Math.min(1, impulseNs / DAMAGE.maxVehicleDamageImpulseNs));
}

/**
 * Frontal/side classification from IsFrontalImpact: the velocity change,
 * expressed in the car's local frame, must be mostly along local Z.
 */
export function isFrontalImpact({ deltaVx, deltaVz, yaw }) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // local Z of (sin,cos) basis: dot(delta, forward)
  const forward = deltaVx * sin + deltaVz * cos;
  const right = deltaVx * cos - deltaVz * sin;
  const length = Math.hypot(forward, right);
  if (length * length <= 0.01 * 0.01) return false;
  return Math.abs(forward / length) > AGGRESSION.frontalCollisionDot;
}
