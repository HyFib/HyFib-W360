'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@w360/ui';
import { completeWhatsAppSignupAction, startWhatsAppSignupAction } from '@/app/actions/channels';
import { FormError, FormSuccess } from '@/components/form-status';

interface FacebookSdk {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: { sessionInfoVersion: string };
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

interface SessionInfo {
  wabaId: string;
  phoneNumberId: string;
  businessId?: string;
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

function loadSdk(appId: string, version: string): Promise<FacebookSdk> {
  return new Promise((resolve, reject) => {
    const ready = () => {
      const fb = window.FB;
      if (!fb) return reject(new Error('Facebook SDK unavailable'));
      fb.init({ appId, autoLogAppEvents: false, xfbml: false, version });
      resolve(fb);
    };
    if (window.FB) return ready();
    window.fbAsyncInit = ready;
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => reject(new Error('Facebook SDK failed to load'));
    document.body.appendChild(script);
  });
}

function isFacebookOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'facebook.com' || host.endsWith('.facebook.com');
  } catch {
    return false;
  }
}

/**
 * Meta Embedded Signup. The browser only relays Meta's authorization code and the ids from Meta's
 * session-info message; the server verifies everything before connecting anything.
 */
export function WhatsAppConnect({
  slug,
  label = 'Connect WhatsApp number',
}: {
  slug: string;
  label?: string;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting' | 'completing' | 'done'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const sessionInfo = useRef<SessionInfo | null>(null);
  const sessionWaiter = useRef<((info: SessionInfo) => void) | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFacebookOrigin(event.origin)) return;
      let data: unknown = event.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (typeof data !== 'object' || data === null) return;
      const message = data as {
        type?: unknown;
        event?: unknown;
        data?: { waba_id?: unknown; phone_number_id?: unknown; business_id?: unknown };
      };
      if (message.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (
        message.event === 'FINISH' &&
        typeof message.data?.waba_id === 'string' &&
        typeof message.data.phone_number_id === 'string'
      ) {
        const info: SessionInfo = {
          wabaId: message.data.waba_id,
          phoneNumberId: message.data.phone_number_id,
          ...(typeof message.data.business_id === 'string'
            ? { businessId: message.data.business_id }
            : {}),
        };
        sessionInfo.current = info;
        sessionWaiter.current?.(info);
      } else if (message.event === 'CANCEL') {
        setError('Signup was cancelled before it finished.');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Resolves when Meta's session-info message arrives (it can trail the login callback). */
  const waitForSessionInfo = (timeoutMs: number) =>
    new Promise<SessionInfo | null>((resolve) => {
      if (sessionInfo.current) return resolve(sessionInfo.current);
      const timer = setTimeout(() => {
        sessionWaiter.current = null;
        resolve(null);
      }, timeoutMs);
      sessionWaiter.current = (info) => {
        clearTimeout(timer);
        sessionWaiter.current = null;
        resolve(info);
      };
    });

  const connect = async () => {
    setError(null);
    setPhase('starting');
    sessionInfo.current = null;
    const started = await startWhatsAppSignupAction(slug);
    if (!started.ok) {
      setError(started.message);
      setPhase('idle');
      return;
    }
    let fb: FacebookSdk;
    try {
      fb = await loadSdk(started.data.appId, started.data.graphApiVersion);
    } catch {
      setError(
        'Facebook’s signup window could not be loaded. Allow facebook.com in your browser and try again.',
      );
      setPhase('idle');
      return;
    }
    setPhase('waiting');
    fb.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          setError('Signup was cancelled or did not finish.');
          setPhase('idle');
          return;
        }
        void (async () => {
          setPhase('completing');
          const info = await waitForSessionInfo(5_000);
          if (!info) {
            setError(
              'Meta did not report which account and number were selected. Please try again.',
            );
            setPhase('idle');
            return;
          }
          const result = await completeWhatsAppSignupAction(slug, {
            state: started.data.state,
            code,
            wabaId: info.wabaId,
            phoneNumberId: info.phoneNumberId,
            ...(info.businessId ? { businessId: info.businessId } : {}),
          });
          if (result.ok) {
            setPhase('done');
          } else {
            setError(result.message);
            setPhase('idle');
          }
        })();
      },
      {
        config_id: started.data.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { sessionInfoVersion: '3' },
      },
    );
  };

  return (
    <div className="grid gap-3">
      <div>
        <Button onClick={() => void connect()} disabled={phase !== 'idle' && phase !== 'done'}>
          {phase === 'starting'
            ? 'Preparing…'
            : phase === 'waiting'
              ? 'Waiting for Meta…'
              : phase === 'completing'
                ? 'Verifying…'
                : label}
        </Button>
      </div>
      <div aria-live="polite" className="grid gap-2">
        <FormError message={error} />
        {phase === 'done' ? (
          <FormSuccess message="Number connected. Setup (webhook subscription, registration and health check) continues in the background." />
        ) : null}
      </div>
    </div>
  );
}
