import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CurrentUser, Public, type AuthUser } from '../auth/auth';
import { StatsModule } from '../stats/stats.module';
import { SessionsService } from './sessions.service';

class JoinQueueDto {
  @IsString() game!: string;
  @IsString() region!: string;
}

class DeviceDto {
  @IsString() name!: string;
  @IsIn(['desktop', 'phone', 'tablet', 'tv']) kind!: string;
  @IsOptional() @IsString() userAgent?: string;
}

class StartSessionDto {
  @IsString() queueId!: string;
  @IsOptional() @IsIn(['Steam', 'GOG', 'Epic']) launcher?: string;
  @IsOptional() @IsString() resolution?: string;
  @IsOptional() @IsInt() fps?: number;
  @IsOptional() @ValidateNested() @Type(() => DeviceDto) device?: DeviceDto;
}

@ApiTags('sessions')
@ApiBearerAuth()
@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Public()
  @Get('regions')
  regions() {
    return this.sessions.regions();
  }

  @Post('queue')
  join(@CurrentUser() { userId }: AuthUser, @Body() dto: JoinQueueDto) {
    return this.sessions.join(userId, dto.game, dto.region);
  }

  @Get('queue/:id')
  status(@CurrentUser() { userId }: AuthUser, @Param('id') id: string) {
    return this.sessions.status(userId, id);
  }

  @Delete('queue/:id')
  @HttpCode(204)
  async leave(@CurrentUser() { userId }: AuthUser, @Param('id') id: string) {
    await this.sessions.leave(userId, id);
  }

  @Post('sessions')
  start(@CurrentUser() { userId }: AuthUser, @Body() dto: StartSessionDto) {
    return this.sessions.start(userId, dto.queueId, dto);
  }

  @Post('sessions/:id/end')
  end(@CurrentUser() { userId }: AuthUser, @Param('id') id: string) {
    return this.sessions.end(userId, id);
  }

  @Get('sessions')
  history(@CurrentUser() { userId }: AuthUser) {
    return this.sessions.history(userId);
  }

  @Get('sessions/recent')
  recent(@CurrentUser() { userId }: AuthUser) {
    return this.sessions.recent(userId);
  }
}

@Module({ imports: [StatsModule], controllers: [SessionsController], providers: [SessionsService] })
export class SessionsModule {}
