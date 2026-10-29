/**
 * An operator who approves selling a lot below its loss floor approves the whole quantity on the card, not one lot of it.
 * Until now the sale stopped after the first lot (the price was still under the floor, which is why a card was raised), and
 * a new card came about 15 minutes later: five approvals for one holding of graviton emitters on 2026-10-29, each selling 18 units
 * (about -920k in all).
 *
 * After an approval the mid-sale loss-floor checks are waived while each lot still fetches at least `1 - tolerancePct` of the
 * price the card quoted. A bigger drop stops the sale and asks again. Pure: no I/O, no clock.
 */
export const APPROVED_SALE_TOLERANCE_PCT = 20;

export function approvedSaleAllows(approvedQuote: number | undefined, lotPrice: number, tolerancePct = APPROVED_SALE_TOLERANCE_PCT): boolean {
  if (approvedQuote === undefined || !(approvedQuote > 0)) return false;
  return lotPrice >= approvedQuote * (1 - tolerancePct / 100);
}
