export interface RollResult {
  readonly dice_expression: string;
  readonly rolls: readonly number[];
  readonly modifier: number;
  readonly total: number;
}

export interface SavingThrow {
  readonly character_name: string;
  readonly ability: string;
  readonly dc: number;
  readonly bonus: number;
  readonly roll: RollResult;
  readonly success: boolean;
}
