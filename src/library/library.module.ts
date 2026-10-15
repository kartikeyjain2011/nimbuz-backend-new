import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Patch, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { CurrentUser, type AuthUser } from '../auth/auth';
import { GamesService } from '../games/games.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

class UpdateItemDto {
  @IsOptional() @IsBoolean() favorite?: boolean;
  @IsOptional() @IsBoolean() hidden?: boolean;
}

class ListQuery {
  @IsOptional() @IsIn(['all', 'favorites', 'recent']) filter?: 'all' | 'favorites' | 'recent';
}

@Injectable()
export class LibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly games: GamesService,
    private readonly users: UsersService,
  ) {}

  list(userId: string, filter: 'all' | 'favorites' | 'recent' = 'all') {
    return this.prisma.libraryItem.findMany({
      where: { userId, hidden: false, ...(filter === 'favorites' && { favorite: true }), ...(filter === 'recent' && { lastPlayed: { not: null } }) },
      include: { game: true },
      orderBy: filter === 'recent' ? { lastPlayed: 'desc' } : { addedAt: 'desc' },
    });
  }

  async add(userId: string, slug: string) {
    await this.users.ensure(userId);
    const game = await this.games.get(slug);
    return this.prisma.libraryItem.upsert({
      where: { userId_gameSlug: { userId, gameSlug: game.slug } },
      create: { userId, gameSlug: game.slug },
      update: { hidden: false },
      include: { game: true },
    });
  }

  update(userId: string, slug: string, dto: UpdateItemDto) {
    return this.prisma.libraryItem.update({ where: { userId_gameSlug: { userId, gameSlug: slug } }, data: dto, include: { game: true } });
  }

  remove(userId: string, slug: string) {
    return this.prisma.libraryItem.deleteMany({ where: { userId, gameSlug: slug } });
  }
}

@ApiTags('library')
@ApiBearerAuth()
@Controller('library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get()
  list(@CurrentUser() { userId }: AuthUser, @Query() q: ListQuery) {
    return this.library.list(userId, q.filter);
  }

  @Put(':slug')
  add(@CurrentUser() { userId }: AuthUser, @Param('slug') slug: string) {
    return this.library.add(userId, slug);
  }

  @Patch(':slug')
  update(@CurrentUser() { userId }: AuthUser, @Param('slug') slug: string, @Body() dto: UpdateItemDto) {
    return this.library.update(userId, slug, dto);
  }

  @Delete(':slug')
  @HttpCode(204)
  async remove(@CurrentUser() { userId }: AuthUser, @Param('slug') slug: string) {
    await this.library.remove(userId, slug);
  }
}

@Module({ controllers: [LibraryController], providers: [LibraryService], exports: [LibraryService] })
export class LibraryModule {}
