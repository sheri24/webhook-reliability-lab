import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { runtimeConfig } from '../config/runtime-config.js';

@Injectable()
export class WebhookSignatureService {
  sign(rawBody: Buffer): string {
    const digest = createHmac('sha256', runtimeConfig.webhookHmacSecret)
      .update(rawBody)
      .digest('hex');
    return `sha256=${digest}`;
  }

  verify(rawBody: Buffer, signature: string | undefined): void {
    const match = typeof signature === 'string' ? /^sha256=([a-f0-9]{64})$/i.exec(signature) : null;
    if (!match) {
      throw new UnauthorizedException('A valid X-Webhook-Signature header is required');
    }

    const receivedDigest = Buffer.from(match[1], 'hex');
    const expectedDigest = createHmac('sha256', runtimeConfig.webhookHmacSecret)
      .update(rawBody)
      .digest();

    if (receivedDigest.length !== expectedDigest.length || !timingSafeEqual(receivedDigest, expectedDigest)) {
      throw new UnauthorizedException('Webhook signature is invalid');
    }
  }
}
