// Documented Artifacts MMO error codes (data/openapi.json v8.2.4 plus the generic HTTP codes the spec omits).
// Policy is data: classification is a table; `classify(code)` is pure.

export type ErrorClass = 'retryable-after-cooldown' | 'retryable-backoff' | 'fatal' | 'caller-bug';

export interface ErrorInfo { code: number; name: string; message: string; cls: ErrorClass }

const E = (code: number, name: string, message: string, cls: ErrorClass): ErrorInfo => ({ code, name, message, cls });

export const ERROR_TABLE: readonly ErrorInfo[] = [
  // generic HTTP (not in spec's per-route lists but returned by the gateway)
  E(404, 'NOT_FOUND', 'Resource not found.', 'caller-bug'),
  E(422, 'VALIDATION', 'Request body or parameters failed validation.', 'caller-bug'),
  E(429, 'RATE_LIMIT', 'Rate limit exceeded.', 'retryable-backoff'),
  E(452, 'TOKEN_INVALID', 'Token is invalid.', 'fatal'),
  E(453, 'TOKEN_EXPIRED', 'Token has expired.', 'fatal'),
  E(454, 'TOKEN_MISSING', 'Token is missing.', 'fatal'),
  // grand exchange
  E(433, 'GE_MAX_ORDERS', 'You cannot create more than 100 orders at the same time.', 'caller-bug'),
  E(434, 'GE_NOT_ENOUGH_ITEMS', 'This offer does not contain that many items.', 'caller-bug'),
  E(435, 'GE_SELF_TRADE', 'You cannot trade with yourself.', 'caller-bug'),
  E(436, 'GE_TRANSACTION_IN_PROGRESS', 'A transaction is already in progress for this order by another character.', 'retryable-backoff'),
  E(437, 'GE_ITEM_NOT_SELLABLE', 'This item cannot be sold.', 'caller-bug'),
  E(438, 'GE_NOT_YOUR_ORDER', 'You cannot cancel an order that is not yours.', 'caller-bug'),
  E(441, 'NPC_NOT_AVAILABLE', 'This item is not available for purchase.', 'caller-bug'),
  // account
  E(451, 'MEMBERS_ONLY', 'Access denied, you must be a member to do that.', 'fatal'),
  E(455, 'TOKEN_GENERATION_FAILED', 'Failed to generate token.', 'fatal'),
  E(456, 'USERNAME_TAKEN', 'This username is already taken.', 'caller-bug'),
  E(457, 'EMAIL_IN_USE', 'This email is already in use.', 'caller-bug'),
  E(458, 'PASSWORD_REUSE', 'Please use a different password.', 'caller-bug'),
  E(459, 'PASSWORD_INVALID', 'The current password you entered is invalid.', 'caller-bug'),
  E(463, 'EMAIL_REUSE', 'Please use a different email.', 'caller-bug'),
  // bank
  E(460, 'BANK_GOLD_INSUFFICIENT', 'Insufficient gold in your bank.', 'caller-bug'),
  E(461, 'BANK_TRANSACTION_IN_PROGRESS', 'Some of your items or your gold in the bank are already part of an ongoing transaction.', 'retryable-backoff'),
  E(462, 'BANK_FULL', 'Your bank is full.', 'caller-bug'),
  // items / tasks
  E(473, 'NOT_RECYCLABLE', 'This item cannot be recycled.', 'caller-bug'),
  E(474, 'TASK_NOT_HELD', 'The character does not have this task.', 'caller-bug'),
  E(475, 'TASK_ALREADY_DONE', 'Task already completed or too many items submitted.', 'caller-bug'),
  E(476, 'NOT_CONSUMABLE', 'This item is not a consumable.', 'caller-bug'),
  E(478, 'MISSING_ITEM', 'Missing required item(s).', 'caller-bug'),
  E(483, 'UNEQUIP_HP_LOW', 'The character does not have enough HP to unequip this item.', 'caller-bug'),
  E(484, 'UTILITY_STACK_MAX', 'The character cannot equip more than 100 utilities in the same slot.', 'caller-bug'),
  E(485, 'ALREADY_EQUIPPED', 'This item is already equipped.', 'caller-bug'),
  E(486, 'ACTION_IN_PROGRESS', 'An action is already in progress for this character.', 'retryable-backoff'),
  E(487, 'NO_TASK', 'The character has no task assigned.', 'caller-bug'),
  E(488, 'TASK_NOT_COMPLETE', 'The character has not completed the task.', 'caller-bug'),
  E(489, 'TASK_ALREADY_ASSIGNED', 'The character already has an assigned task.', 'caller-bug'),
  E(490, 'ALREADY_AT_DESTINATION', 'The character is already at the destination.', 'caller-bug'),
  E(491, 'SLOT_NOT_EMPTY', 'The equipment slot is not empty.', 'caller-bug'),
  E(492, 'GOLD_INSUFFICIENT', 'Insufficient gold for this transaction.', 'caller-bug'),
  E(493, 'SKILL_TOO_LOW', "The character's skill level is too low.", 'caller-bug'),
  E(494, 'NAME_IN_USE', 'This name is already in use.', 'caller-bug'),
  E(495, 'MAX_CHARACTERS', 'You have reached the maximum number of characters on your account.', 'fatal'),
  E(496, 'CONDITIONS_NOT_MET', 'Conditions not met.', 'caller-bug'),
  E(497, 'INVENTORY_FULL', "The character's inventory is full.", 'caller-bug'),
  E(498, 'CHARACTER_NOT_FOUND', 'Character not found.', 'caller-bug'),
  E(499, 'COOLDOWN', 'The character is in cooldown.', 'retryable-after-cooldown'),
  // skins / gems / events / raids / assistant
  E(550, 'SKIN_NOT_OWNED', 'You cannot choose this skin because you do not own it.', 'caller-bug'),
  E(551, 'SKIN_OWNED', 'You already own this skin.', 'caller-bug'),
  E(552, 'SKIN_NOT_PURCHASABLE', 'This skin is not available for purchase.', 'caller-bug'),
  E(560, 'RESET_TOKEN_INVALID', 'The password reset token is invalid.', 'caller-bug'),
  E(561, 'RESET_TOKEN_EXPIRED', 'The password reset token has expired.', 'caller-bug'),
  E(562, 'RESET_TOKEN_USED', 'This password reset token has already been used.', 'caller-bug'),
  E(563, 'GEMS_INSUFFICIENT', 'Insufficient gems.', 'caller-bug'),
  E(564, 'EVENT_LIMIT', 'Event already active or maximum active events reached.', 'caller-bug'),
  E(565, 'SUBSCRIPTION_ACTIVE', 'You already have an active subscription.', 'caller-bug'),
  E(566, 'EVENT_ON_COOLDOWN', 'This event is on cooldown and cannot be spawned yet.', 'retryable-backoff'),
  E(567, 'RAID_PHASE_INACTIVE', 'This raid phase is not currently active.', 'retryable-backoff'),
  E(570, 'ASSISTANT_DAILY_LIMIT', 'You have reached the daily limit for assistant questions. Try again tomorrow.', 'fatal'),
  E(571, 'EVENT_NOT_PURCHASABLE', 'This event is not available for purchase.', 'caller-bug'),
  E(572, 'MEMBER_TOKENS_INSUFFICIENT', 'Insufficient member tokens.', 'caller-bug'),
  E(573, 'SUBSCRIPTION_NOT_EXTENDABLE', 'An active Stripe subscription cannot be extended with gems or member tokens.', 'caller-bug'),
  // map / monsters
  E(595, 'NO_PATH', 'No path available to the destination map.', 'caller-bug'),
  E(596, 'MAP_BLOCKED', 'The map is blocked and cannot be accessed.', 'caller-bug'),
  E(598, 'NO_MONSTER', 'Monster not found on this map.', 'caller-bug'),
];

const BY_CODE = new Map(ERROR_TABLE.map((e) => [e.code, e]));

export function errorInfo(code: number): ErrorInfo | undefined { return BY_CODE.get(code); }

/** Unknown 5xx -> backoff (server trouble); other unknown codes -> caller-bug (do not loop on what we do not understand). */
export function classify(code: number): ErrorClass {
  const known = BY_CODE.get(code);
  if (known) return known.cls;
  if (code >= 500 && code < 600) return 'retryable-backoff';
  return 'caller-bug';
}

export class ApiError extends Error {
  readonly code: number;
  readonly cls: ErrorClass;
  readonly status: number;
  readonly data: unknown;
  constructor(code: number, message: string, status: number, data?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'ApiError';
    this.code = code;
    this.cls = classify(code);
    this.status = status;
    this.data = data;
  }
}
