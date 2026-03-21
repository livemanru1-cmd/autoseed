import type { BrowserPermissions } from '../types';

function canUseWindowOpen(): boolean {
  try {
    const popup = window.open('', '_blank', 'noopener,noreferrer,width=64,height=64');
    if (!popup) return false;
    popup.close();
    return true;
  } catch {
    return false;
  }
}

async function probeSteamProtocol(): Promise<boolean> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    let finished = false;

    const finalize = (value: boolean) => {
      if (finished) return;
      finished = true;
      iframe.remove();
      resolve(value);
    };

    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    const timeout = window.setTimeout(() => finalize(true), 1200);

    try {
      iframe.onload = () => {
        window.clearTimeout(timeout);
        finalize(true);
      };
      iframe.src = 'steam://run/393380';
    } catch {
      window.clearTimeout(timeout);
      finalize(false);
    }
  });
}

export async function runPermissionCheck(): Promise<BrowserPermissions> {
  const popupAllowed = canUseWindowOpen();
  const steamProtocolReady = popupAllowed ? await probeSteamProtocol() : false;

  return {
    popupAllowed,
    steamProtocolReady,
    checkedAt: Date.now()
  };
}

