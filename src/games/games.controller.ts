import { BadRequestException, Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CurrentUser, Public, type AuthUser } from '../auth/auth';
import { GamesService, type Feed } from './games.service';

class ListQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() genre?: string;
  @IsOptional() @IsBooleanString() featured?: string;
  /** true = only games installed on the NVMesh game library */
  @IsOptional() @IsBooleanString() installed?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip?: number;
}

const FEEDS: Feed[] = ['popular', 'new', 'top', 'upcoming'];

@ApiTags('games')
@Controller('games')
export class GamesController {
  constructor(
    private readonly games: GamesService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get()
  list(@Query() q: ListQuery) {
    const bool = (v?: string) => (v === undefined ? undefined : v === 'true');
    return this.games.list({ ...q, featured: bool(q.featured), installed: bool(q.installed) });
  }

  @Public()
  @Get('feed/:kind')
  feed(@Param('kind') kind: string) {
    if (!FEEDS.includes(kind as Feed)) throw new BadRequestException(`kind must be one of ${FEEDS.join(', ')}`);
    return this.games.feed(kind as Feed);
  }

  @Public()
  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.games.get(slug);
  }

  @Public()
  @Get(':slug/buy')
  buy(@Param('slug') slug: string) {
    return this.games.buyOptions(slug);
  }

  /** Admin-only full resync. ADMIN_USER_IDS is a comma-separated list of Clerk user ids. */
  @Post('sync')
  sync(@CurrentUser() { userId }: AuthUser) {
    const admins = (this.config.get<string>('ADMIN_USER_IDS') ?? '').split(',').map((s) => s.trim());
    if (!admins.includes(userId)) throw new ForbiddenException();
    return this.games.syncAll();
  }
}
