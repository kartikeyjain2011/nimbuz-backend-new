import { Body, Controller, ForbiddenException, Get, Global, Headers, HttpCode, Module, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InventoryService, type InventoryReportBody } from './inventory.service';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlanId } from '@prisma/client';
import { IsEnum, IsIP, IsOptional, IsString } from 'class-validator';
import { CurrentUser, Public, type AuthUser } from '../auth/auth';
import { KubeService } from './kube.service';
import { StreamTokenService } from './stream-token.service';
import { ANN, LABEL, PUBLIC_IP_ANNOTATION, VmPoolService } from './vm-pool.service';

class VerifyTokenDto {
  @IsString() token!: string;
}

class VerifyNameDto {
  @IsString() name!: string;
}

class AdoptDto {
  @IsString() name!: string;
  @IsString() region!: string;
  @IsEnum(PlanId) tier!: PlanId;
  /** Public IP the VM's agent is reachable on → wss://ip-<dashed>.stream.playnimbuz.com:8443/ws */
  @IsOptional() @IsIP() publicIp?: string;
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
    private readonly inventoryService: InventoryService,
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

  /** Admin: every VM in the namespace, with its pool labels and NVMesh volumes — pick which ones to adopt. */
  @Get('vms')
  async vms(@CurrentUser() { userId }: AuthUser) {
    this.admin(userId);
    const vms = await this.kube.listVMs('');
    return vms.map((vm) => {
      const spec = vm.spec.template as { spec?: { volumes?: { name: string; persistentVolumeClaim?: { claimName: string }; dataVolume?: { name: string } }[] } } | undefined;
      return {
        name: vm.metadata.name,
        status: vm.status?.printableStatus,
        inPool: vm.metadata.labels?.[LABEL.pool] === 'gaming',
        region: vm.metadata.labels?.[LABEL.region],
        tier: vm.metadata.labels?.[LABEL.tier],
        publicIp: vm.metadata.annotations?.[PUBLIC_IP_ANNOTATION],
        leasedBy: vm.metadata.annotations?.[ANN.user],
        instancetype: vm.spec.instancetype?.name,
        volumes: spec?.spec?.volumes?.map((v) => v.persistentVolumeClaim?.claimName ?? v.dataVolume?.name ?? v.name),
      };
    });
  }

  /** Admin: add an existing VM to the pool (labels only — disks and installed games untouched). */
  @Post('pool/adopt')
  adopt(@CurrentUser() { userId }: AuthUser, @Body() dto: AdoptDto) {
    this.admin(userId);
    return this.pool.adopt(dto.name, dto.region, dto.tier, dto.publicIp);
  }

  /** Admin: take a VM out of the pool. */
  @Post('pool/remove')
  async remove(@CurrentUser() { userId }: AuthUser, @Body() dto: VerifyNameDto) {
    this.admin(userId);
    await this.pool.unadopt(dto.name);
    return { ok: true };
  }

  /**
   * Rig → API: what's installed on the NVMesh game library (deploy/agent/report-inventory.ps1).
   * Signed with header `X-Nimbus-Signature: sha256=<hex HMAC of raw body>` using INVENTORY_SECRET.
   */
  @Public()
  @Post('inventory')
  @HttpCode(200)
  inventory(@Req() req: RawBodyRequest<Request>, @Headers('x-nimbus-signature') signature?: string) {
    this.inventoryService.verify(req.rawBody, signature);
    return this.inventoryService.ingest(req.body as InventoryReportBody);
  }

  /** Admin: last inventory reports. */
  @Get('inventory')
  reports(@CurrentUser() { userId }: AuthUser) {
    this.admin(userId);
    return this.inventoryService.latest();
  }

  /** Lets the streaming agent validate a token server-side if it doesn't hold the secret. */
  @Public()
  @Post('stream/verify')
  verify(@Body() dto: VerifyTokenDto) {
    return { valid: !!this.tokens.verify(dto.token), claims: this.tokens.verify(dto.token) };
  }
}

@Global()
@Module({ controllers: [InfraController], providers: [KubeService, VmPoolService, StreamTokenService, InventoryService], exports: [KubeService, VmPoolService, StreamTokenService] })
export class InfraModule {}
