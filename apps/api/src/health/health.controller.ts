import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get()
  async check(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.database.ping();
      return { status: 'ok', database: 'ok' };
    } catch (error: unknown) {
      console.error('Database health check failed:', error instanceof Error ? error.message : error);
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'unavailable' });
    }
  }
}
