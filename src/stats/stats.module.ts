import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthUser } from '../auth/auth';
import { StatsService } from './stats.service';

@ApiTags('stats')
@ApiBearerAuth()
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  overview(@CurrentUser() { userId }: AuthUser) {
    return this.stats.overview(userId);
  }
}

@Module({ controllers: [StatsController], providers: [StatsService], exports: [StatsService] })
export class StatsModule {}
