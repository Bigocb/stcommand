// Single-fight simulator, cooldown and rest math. Pure; RNG is injected.
import { ELEMENTS, type CombatStats, type PerElement } from './stats.js';
import { roundHalfUp } from './xp.js';

export type Rng = () => number; // [0,1)

/** mulberry32 seeded RNG. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MonsterDef {
  code: string; level: number; type?: string; hp: number;
  attack_fire: number; attack_earth: number; attack_water: number; attack_air: number;
  res_fire: number; res_earth: number; res_water: number; res_air: number;
  critical_strike: number; initiative: number;
  effects: { code: string; value: number }[];
  min_gold: number; max_gold: number;
  drops: { code: string; rate: number; min_quantity: number; max_quantity: number }[];
}

export interface LogEntry { turn: number; actor: 'player' | 'monster' | 'poison' | 'burn'; damage: number; crit: boolean; targetHp: number }
export interface FightResult {
  win: boolean; turns: number; startHp: number;
  /** HP the player ends with; a loss returns the character with 1 HP (game rule). */
  hpLeft: number;
  /** HP actually lost in the fight (full startHp - 0 for a loss, before the 1 HP respawn). */
  hpLost: number;
  log: LogEntry[];
  /** monster effect codes present but not simulated */
  unmodeled: string[];
}

export const MAX_TURNS = 100;
const MODELED = new Set(['poison', 'burn', 'lifesteal', 'barrier', 'corrupted']);

/** Round(round(base*(1+(dmg+dmgEl)/100)) * (1-res/100)); crit multiplies each element's post-resistance damage by 1.5. */
export function elementDamage(base: number, dmg: number, dmgEl: number, res: number, crit: boolean): number {
  if (base <= 0) return 0;
  const att = roundHalfUp(base * (1 + (dmg + dmgEl) / 100));
  const fin = roundHalfUp(att * (1 - res / 100));
  return crit ? roundHalfUp(fin * 1.5) : fin;
}

export function monsterAttack(m: MonsterDef): PerElement {
  return { fire: m.attack_fire, earth: m.attack_earth, water: m.attack_water, air: m.attack_air };
}
export function monsterRes(m: MonsterDef): PerElement {
  return { fire: m.res_fire, earth: m.res_earth, water: m.res_water, air: m.res_air };
}

export function simulateFight(player: CombatStats, monster: MonsterDef, rng: Rng, startHp: number = player.maxHp): FightResult {
  const eff = (c: string) => monster.effects.find((e) => e.code === c)?.value ?? 0;
  const unmodeled = monster.effects.map((e) => e.code).filter((c) => !MODELED.has(c));
  const mAtk = monsterAttack(monster);
  const mRes = monsterRes(monster);
  const mTotalAtk = ELEMENTS.reduce((s, e) => s + mAtk[e], 0);
  const poison = eff('poison'), burnPct = eff('burn'), lifesteal = eff('lifesteal'), barrierSize = eff('barrier'), corrupt = eff('corrupted');
  const pRes: PerElement = { ...player.res };
  const mResLive: PerElement = { ...mRes }; // corrupted: monster res drops each time it is attacked

  let pHp = startHp, mHp = monster.hp, barrier = barrierSize;
  const log: LogEntry[] = [];
  let monsterActed = false, burnLeft = 0, burnStart = 0, mTurns = 0;

  const playerFirst = player.initiative !== monster.initiative ? player.initiative > monster.initiative
    : pHp !== mHp ? pHp > mHp : rng() < 0.5;

  const dot = (turn: number): boolean => { // returns true if player died
    if (poison && monsterActed) { pHp -= poison; log.push({ turn, actor: 'poison', damage: poison, crit: false, targetHp: pHp }); }
    if (burnLeft > 0) {
      const d = roundHalfUp(burnStart * (burnLeft / 10));
      burnLeft--;
      if (d > 0) { pHp -= d; log.push({ turn, actor: 'burn', damage: d, crit: false, targetHp: pHp }); }
    }
    return pHp <= 0;
  };

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const isPlayer = (turn % 2 === 1) === playerFirst;
    if (isPlayer) {
      if (dot(turn)) break;
      const crit = rng() * 100 < player.critical;
      let dmg = 0;
      for (const e of ELEMENTS) dmg += elementDamage(player.attack[e], player.dmg, player.dmgEl[e], mResLive[e], crit);
      if (corrupt) for (const e of ELEMENTS) if (player.attack[e] > 0) mResLive[e] -= corrupt;
      // barrier absorbs everything until destroyed (overflow is lost)
      if (barrier > 0) { barrier -= dmg; dmg = 0; }
      mHp -= dmg;
      log.push({ turn, actor: 'player', damage: dmg, crit, targetHp: mHp });
      if (mHp <= 0) return done(true, turn);
    } else {
      mTurns++;
      if (barrierSize && mTurns > 1 && (mTurns - 1) % 5 === 0) barrier = barrierSize;
      if (!monsterActed) { monsterActed = true; if (burnPct) { burnStart = Math.round(mTotalAtk * burnPct / 100); burnLeft = 10; } }
      const crit = rng() * 100 < monster.critical_strike;
      let dmg = 0;
      for (const e of ELEMENTS) dmg += elementDamage(mAtk[e], 0, 0, pRes[e], crit);
      pHp -= dmg;
      log.push({ turn, actor: 'monster', damage: dmg, crit, targetHp: pHp });
      if (crit && lifesteal) mHp = Math.min(monster.hp, mHp + roundHalfUp(mTotalAtk * lifesteal / 100));
      if (pHp <= 0) return done(false, turn);
    }
  }
  return done(false, Math.min(log.length ? log[log.length - 1]!.turn : MAX_TURNS, MAX_TURNS));

  function done(win: boolean, turns: number): FightResult {
    const hpLost = Math.min(startHp, Math.max(0, startHp - pHp));
    return { win, turns, startHp, hpLeft: win ? pHp : 1, hpLost: win ? hpLost : startHp, log, unmodeled };
  }
}

/** Fight cooldown seconds: turns*2 reduced by haste %, minimum 5s. (20 turns, 10 haste = 36s.) */
export function fightCooldown(turns: number, haste: number): number {
  return Math.max(5, Math.ceil(turns * 2 * (1 - haste / 100) - 1e-9));
}

/** Rest cooldown: 1s per 5 HP restored, minimum 3s (0 if nothing to restore). */
export function restSeconds(hpToRestore: number): number {
  return hpToRestore <= 0 ? 0 : Math.max(3, Math.ceil(hpToRestore / 5));
}
