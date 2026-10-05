import { chooseFlightMode } from "./flightMode.js";

/** FUEL is sold in blocks of 100 tank-fuel (a 300-fuel top-up is 2 units at the listed price in the ledger). */
export const FUEL_UNIT_SIZE = 100;

/**
 * Fraction a market's price moves per full lot (its own tradeVolume) of our
 * units, in the direction of our trade (buying lifts the ask, selling sinks
 * the bid). Measured 2026-10-05: FAB_MATS 20-unit lots +3.5-5.6% each,
 * +0.6% for a 3-unit buy, price a pure function of stock. Treated as linear
 * in units/tradeVolume, so a whole hold of an N-lot trip moves price by about
 * N x this, and the AVERAGE price paid/received sits half way along it.
 */
export const PRICE_IMPACT_PER_LOT = 0.045;

/** Minimum per-unit margin as a share of the buy price, applied on top of the doctrine's flat marginFloor so a
 *  3,000c good needs more than a 22c good does to clear the same flat 10c. */
export const MIN_MARGIN_PCT = 0.02;

/** A trip this long (seconds) keeps its profit as its ranking score; faster trips score higher, slower lower. */
export const REFERENCE_TRIP_SECONDS = 600;

/** SpaceTraders travel time: round(distance x multiplier / speed) + 15 per leg. */
const CRUISE_TIME_MULTIPLIER = 25;
const BURN_TIME_MULTIPLIER = 12.5;
/** Used when no ship speed is known (a fleet with no hull yet). */
export const DEFAULT_SHIP_SPEED = 30;

export function effectiveMarginFloor(flatFloor: number, buyPrice: number): number {
  return Math.max(flatFloor, buyPrice * MIN_MARGIN_PCT);
}

export interface LegTravel {
  /** Tank-fuel burned on one leg. */
  fuelPerLeg: number;
  /** Seconds for one leg. */
  secondsPerLeg: number;
  burn: boolean;
}

/** One leg's fuel and time, for the flight mode the trader will actually pick (BURN burns 2x fuel for half the
 *  transit, chosen when the tank can afford it - see flightMode.ts). `fuelCapacity` <= 0 means a fuel-free hull. */
export function legTravel(distance: number, fuelCapacity: number, speed: number): LegTravel {
  const d = Math.max(1, distance);
  const burn = fuelCapacity > 0 && chooseFlightMode(d, fuelCapacity, fuelCapacity) === "BURN";
  const mult = burn ? BURN_TIME_MULTIPLIER : CRUISE_TIME_MULTIPLIER;
  const s = speed > 0 ? speed : DEFAULT_SHIP_SPEED;
  return {
    fuelPerLeg: fuelCapacity > 0 ? d * (burn ? 2 : 1) : 0,
    secondsPerLeg: Math.round(d * (mult / s)) + 15,
    burn,
  };
}

/** Credits for `fuel` tank-fuel at `fuelPrice` per 100-unit block. */
export function fuelCredits(fuel: number, fuelPrice: number): number {
  return (fuel * fuelPrice) / FUEL_UNIT_SIZE;
}

/** Cost of our own units' price impact over the whole trip: the average price paid sits half way along the move. */
export function slippageCredits(units: number, tradeVolume: number, price: number): number {
  if (units <= 0 || price <= 0) return 0;
  const lots = units / Math.max(1, tradeVolume);
  return price * units * ((lots * PRICE_IMPACT_PER_LOT) / 2);
}

export interface TripInput {
  buyPrice: number;
  sellPrice: number;
  units: number;
  buyVolume: number;
  sellVolume: number;
  /** Same-system buy->sell distance. */
  distance: number;
  fuelPrice: number;
  fuelCapacity: number;
  speed: number;
}

export interface TripEconomics {
  gross: number;
  fuelCost: number;
  slippage: number;
  net: number;
  /** Round trip, buy -> sell -> back to buy. */
  seconds: number;
  /** Seconds per unit of distance, for costing a positioning leg the same way. */
  secPerDist: number;
  fuelBurned: number;
  burn: boolean;
}

/**
 * Net of one repeating same-system round trip: spread on the units, minus
 * the fuel for BOTH legs (the ship flies back to the buy market empty, and
 * that fuel and time are real), minus our own price impact on each side.
 */
export function tripEconomics(t: TripInput): TripEconomics {
  const leg = legTravel(t.distance, t.fuelCapacity, t.speed);
  const fuelBurned = leg.fuelPerLeg * 2;
  const fuelCost = fuelCredits(fuelBurned, t.fuelPrice);
  const slippage = slippageCredits(t.units, t.buyVolume, t.buyPrice) + slippageCredits(t.units, t.sellVolume, t.sellPrice);
  const gross = (t.sellPrice - t.buyPrice) * t.units;
  return {
    gross,
    fuelCost,
    slippage,
    net: gross - fuelCost - slippage,
    seconds: leg.secondsPerLeg * 2,
    secPerDist: leg.secondsPerLeg / Math.max(1, t.distance),
    fuelBurned,
    burn: leg.burn,
  };
}

/**
 * Whether topping up now is worth a market stop. FUEL is billed per 100-unit block, so a 300-tank ship that is
 * 20 short pays for 100; only refuel once at least a block is missing, or below half a tank. Tanks under 100 pay
 * one block whatever they take, so they keep topping up whenever they are not nearly full.
 */
export function refuelWorthwhile(current: number, capacity: number): boolean {
  if (capacity <= 0 || current >= capacity) return false;
  if (capacity < FUEL_UNIT_SIZE) return current < capacity * 0.95;
  return capacity - current >= FUEL_UNIT_SIZE || current < capacity * 0.5;
}
