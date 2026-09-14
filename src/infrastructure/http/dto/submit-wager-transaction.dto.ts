import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEnum, IsOptional, IsString, IsUUID, ValidateNested } from "class-validator";
import { WagerTransactionKind } from "../../../domain/wager-transaction/wager-transaction";
import { MoneyDto } from "./money.dto";

export class SubmitWagerTransactionDto {
  @ApiProperty({ example: "provider-a" })
  @IsString()
  providerId!: string;

  @ApiProperty({ example: "transaction-123" })
  @IsString()
  externalTransactionId!: string;

  @ApiProperty({ example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ example: "0192f291-27dd-7d3f-8071-5f8685deef37" })
  @IsUUID()
  walletId!: string;

  @ApiProperty({ example: "round-987" })
  @IsString()
  roundId!: string;

  @ApiProperty({ example: "fortune-chimp" })
  @IsString()
  gameId!: string;

  @ApiProperty({ enum: WagerTransactionKind })
  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @ApiProperty({ type: MoneyDto })
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}
