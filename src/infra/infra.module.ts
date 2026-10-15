import { Body, Controller, ForbiddenException, Get, Global, Module, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { CurrentUser, Public, type AuthUser } from '../auth/auth';
import { KubeService } from './kube.service';
import { StreamTokenService } from './stream-token.service';
import { VmPoolService } from './vm-pool.service';

class VerifyTokenDto {
  @IsString() token!: string;
}

@ApiTags('infra')
@ApiBearerAuth()
@Controller('infra')
export class InfraController {
  constructor(
    private readonly kube: KubeService,
    private readonly pool: VmPoolService,
    private readonly tokens: StreamTokenService,
    private readonly config: ConfigService,
  ) {}

  private admin(userId: string) {
    const admins = (this.config.get<string>('ADMIN_USER_IDS') ?? '').split(',').map((s) => s.trim());
    if (!admins.includes(userId)) throw new ForbiddenException();
  }

  /** Admin: VM pool per region/tier + cluster nodes. */
  @Get('pool')
  async poolStatus(@CurrentUser() { userId }: AuthUser) {
    this.admin(userId);
    const [capacity, nodes] = await Promise.all([this.pool.capacity(), this.kube.enabled ? this.kube.nodes() : Promise.resolve([])]);
    return {
      connected: this.kube.enabled,
      capacity,
      nodes: nodes.map((n) => ({ name: n.metadata.name, cpu: n.status.capacity?.cpu, memory: n.status.capacity?.memory, gpus: n.status.capacity?.['nvidia.com/gpu'] ?? '0' })),
    };
  }

  /** Admin: force a pool reconcile now. */
  @Post('pool/reconcile')
  async reconcile(@CurrentUser() { userId }: AuthUser) {
    this.admin(userId);
    await this.pool.reconcile();
    return this.pool.capacity();
  }

  /** Lets the streaming agent validate a token server-side if it doesn't hold the secret. */
  @Public()
  @Post('stream/verify')
  verify(@Body() dto: VerifyTokenDto) {
    return { valid: !!this.tokens.verify(dto.token), claims: this.tokens.verify(dto.token) };
  }
}

@Global()
@Module({ controllers: [InfraController], providers: [KubeService, VmPoolService, StreamTokenService], exports: [KubeService, VmPoolService, StreamTokenService] })
export class InfraModule {}
