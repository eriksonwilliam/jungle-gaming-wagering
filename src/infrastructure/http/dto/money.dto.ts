import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class MoneyDto {
  @ApiProperty({ example: "25.00" })
  @IsString()
  @IsNotEmpty()
  amount!: string;

  @ApiProperty({ example: "BRL" })
  @IsString()
  @IsNotEmpty()
  currency!: string;
}
