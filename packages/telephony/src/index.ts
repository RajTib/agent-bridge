export * from './types.js';
export * from './voice-script.js';
export * from './twilio.js';
export * from './mock.js';
export * from './call-manager.js';

import type { AppConfig } from '@agentbridge/core';
import { MockTelephonyProvider } from './mock.js';
import { TwilioProvider } from './twilio.js';
import type { TelephonyProvider } from './types.js';

export function createProvider(config: AppConfig): TelephonyProvider | null {
  switch (config.telephony.provider) {
    case 'twilio':
      return new TwilioProvider(config.twilio);
    case 'mock':
      return new MockTelephonyProvider();
    case 'none':
      return null;
  }
}
