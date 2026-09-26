export interface RollResult {
  readonly dice_expression: string;
  readonly rolls: readonly number[];
  readonly modifier: number;
  readonly total: number;
}

export interface AttackRoll {
  readonly attacker_name: string;
  readonly target_name: string;
  readonly attack_bonus: number;
  readonly target_ac: number;
  readonly roll: RollResult;
  readonly hit: boolean;
  readonly critical_hit: boolean;
  readonly critical_miss: boolean;
}

export interface DamageRoll {
  readonly dice_expression: string;
  readonly roll: RollResult;
  readonly damage_type: string;
}

export interface SavingThrow {
  readonly character_name: string;
  readonly ability: string;
  readonly dc: number;
  readonly bonus: number;
  readonly roll: RollResult;
  readonly success: boolean;
}
