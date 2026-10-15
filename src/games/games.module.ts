import { Global, Module } from '@nestjs/common';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { RawgService } from './rawg.service';

@Global()
@Module({ controllers: [GamesController], providers: [GamesService, RawgService], exports: [GamesService] })
export class GamesModule {}
