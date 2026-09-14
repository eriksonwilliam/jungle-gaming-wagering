import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsUUID, ValidateNested } from "class-validator";
import { MoneyDto } from "./money.dto";

export class CreateWalletDto {
  @ApiProperty({ example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ type: MoneyDto })
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
