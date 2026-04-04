import { expect, test, type Page, type Route } from '@playwright/test';

const BASE_TIME = Date.parse('2026-04-04T12:00:00.000Z');
const REDIRECT_TARGET_URL = 'http://127.0.0.1:4173/redirect-target';

const runtimeConfig = {
  app: {
    title: 'BSS AutoConnect 2026',
    debugLogLimit: 80
  },
  policy: {
    timezone: 'Europe/Moscow',
    nightWindowStart: '23:00',
    nightWindowEnd: '08:00',
    nightPreferredServerId: 2,
    maxSeedPlayers: 80,
    priorityOrder: [2, 1],
    switchDelta: 10,
    cooldownMs: 600000,
    periodicReconnectMs: 600000
  },
  exporters: [
    {
      name: 'squadjs1',
      baseUrl: 'http://127.0.0.1:4173/mock/squadjs1'
    },
    {
      name: 'squadjs2',
      baseUrl: 'http://127.0.0.1:4173/mock/squadjs2'
    }
  ]
};

function buildTeam(id: number, name: string, totalPlaytimeHours: number) {
  return {
    id,
    name,
    playerCount: 20,
    playersWithHours: 18,
    totalPlaytimeSeconds: totalPlaytimeHours * 3600,
    totalPlaytimeHours,
    leaderPlaytimeSeconds: 7200,
    leaderPlaytimeHours: 2,
    commanderPlaytimeSeconds: 10800,
    commanderPlaytimeHours: 3,
    squads: [
      {
        id: id * 10,
        name: `${name} Alpha`,
        playerCount: 9,
        totalPlaytimeSeconds: 32400,
        totalPlaytimeHours: 9,
        leaderName: `${name} Lead`,
        leaderPlaytimeSeconds: 7200,
        leaderPlaytimeHours: 2
      }
    ],
    players: [
      {
        eosId: `${name.toLowerCase()}-cmd`,
        steamId: `${id}001`,
        name: `${name} Commander`,
        teamId: id,
        teamName: name,
        squadId: id * 10,
        squadName: `${name} Alpha`,
        role: 'Commander',
        isLeader: true,
        isCommander: true,
        playtimeSeconds: 10800,
        playtimeHours: 3,
        playtimeSource: 'test'
      }
    ]
  };
}

function buildSnapshot({
  id,
  code,
  name,
  playerCount,
  maxPlayers,
  queueLength,
  online
}: {
  id: number;
  code: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  queueLength: number;
  online: boolean;
}) {
  return {
    success: true,
    timestamp: BASE_TIME,
    generatedAt: new Date(BASE_TIME).toISOString(),
    version: 3,
    servers: [
      {
        id,
        code,
        name,
        playerCount,
        maxPlayers,
        queueLength,
        currentLayer: 'Narva RAAS v2',
        gameMode: 'RAAS',
        isSeedCandidate: true,
        online,
        teams: [buildTeam(1, 'Vanguard', 342.6), buildTeam(2, 'Nomad', 287.4)],
        players: [],
        updatedAt: BASE_TIME
      }
    ]
  };
}

async function fulfillJson(route: Route, payload: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload)
  });
}

async function mockAutoseedApi(page: Page, counters?: { joinLinkRequests: number }) {
  await page.route('**/runtime-config.json', (route) => fulfillJson(route, runtimeConfig));
  await page.route('**/mock/**/events', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'text/plain; charset=utf-8',
      body: 'sse unavailable in test'
    })
  );
  await page.route('**/mock/squadjs1/snapshot', (route) =>
    fulfillJson(
      route,
      buildSnapshot({
        id: 1,
        code: 'squadjs1',
        name: '[RU] BSS Classic',
        playerCount: 24,
        maxPlayers: 100,
        queueLength: 0,
        online: false
      })
    )
  );
  await page.route('**/mock/squadjs2/snapshot', (route) =>
    fulfillJson(
      route,
      buildSnapshot({
        id: 2,
        code: 'squadjs2',
        name: '[RU] BSS Spec Ops',
        playerCount: 56,
        maxPlayers: 100,
        queueLength: 2,
        online: true
      })
    )
  );
  await page.route('**/mock/squadjs1/join-link', (route) =>
    fulfillJson(route, {
      ok: true,
      timestamp: BASE_TIME,
      serverId: 1,
      serverCode: 'squadjs1',
      serverName: '[RU] BSS Classic',
      joinLink: REDIRECT_TARGET_URL
    })
  );
  await page.route('**/mock/squadjs2/join-link', async (route) => {
    if (counters) counters.joinLinkRequests += 1;
    await fulfillJson(route, {
      ok: true,
      timestamp: BASE_TIME,
      serverId: 2,
      serverCode: 'squadjs2',
      serverName: '[RU] BSS Spec Ops',
      joinLink: REDIRECT_TARGET_URL
    });
  });
  await page.route('**/redirect-target', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><main data-testid="redirect-target">Точка перехода</main></body></html>'
    })
  );
}

async function mockSuccessfulPermissionCheck(page: Page) {
  await page.addInitScript(() => {
    window.open = () =>
      ({
        document: {
          write() {},
          close() {}
        },
        close() {},
        focus() {},
        closed: false
      }) as unknown as Window;

    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function (
      tagName: string,
      options?: ElementCreationOptions
    ) {
      const element = originalCreateElement.call(this, tagName, options);

      if (tagName.toLowerCase() === 'iframe') {
        let currentSrc = '';

        Object.defineProperty(element, 'src', {
          configurable: true,
          get() {
            return currentSrc;
          },
          set(value) {
            currentSrc = String(value);
            window.setTimeout(() => {
              window.dispatchEvent(new Event('blur'));
            }, 0);
          }
        });
      }

      return element;
    };
  });
}

test('renders the localized control room from exporter snapshots', async ({ page }) => {
  await mockAutoseedApi(page);

  await page.goto('/');

  await expect(page.getByTestId('hero-title')).toHaveText('BSS AutoConnect 2026');
  await expect(page.getByTestId('hero-glance-grid')).toBeVisible();
  await expect(page.getByTestId('overview-target')).toContainText('[RU] BSS Spec Ops');
  await expect(page.getByTestId('server-card-1')).toContainText('[RU] BSS Classic');
  await expect(page.getByTestId('server-card-2')).toContainText('[RU] BSS Spec Ops');
  await expect(page.getByTestId('active-server-board')).toContainText('вход по запросу');
  await expect(page.getByTestId('diagnostics-panel')).toContainText('Правила и диагностика');
  await expect(page.getByTestId('diagnostics-panel')).toContainText('Последний снимок');
});

test('requests join-link on demand and navigates only after the user action', async ({ page }) => {
  const counters = { joinLinkRequests: 0 };
  await mockAutoseedApi(page, counters);

  await page.goto('/');
  await expect(page.getByTestId('primary-direct-join')).toBeVisible();
  expect(counters.joinLinkRequests).toBe(0);

  await Promise.all([
    page.waitForURL('**/redirect-target'),
    page.getByTestId('primary-direct-join').click()
  ]);

  expect(counters.joinLinkRequests).toBe(1);
  await expect(page.getByTestId('redirect-target')).toHaveText('Точка перехода');
});

test('marks browser check as successful and keeps the button green', async ({ page }) => {
  await mockSuccessfulPermissionCheck(page);
  await mockAutoseedApi(page);

  await page.goto('/');

  const button = page.getByTestId('check-browser-button');
  await button.click();

  await expect(button).toContainText('Браузер проверен');
  await expect(button).toHaveClass(/button-success/);
  await expect(page.getByText('Браузер готов')).toBeVisible();
  await expect(page.getByTestId('hero')).toContainText('Браузер готов');
});

test('keeps help popovers visible inside the viewport on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAutoseedApi(page);

  await page.goto('/');

  await page.getByTestId('hero-help-trigger').click();
  await expect(page.getByTestId('hero-help-popover')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  await page.getByTestId('popup-help-trigger').click();
  await expect(page.getByTestId('popup-help-popover')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('keeps the layout usable on mobile without document-level horizontal overflow', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAutoseedApi(page);

  await page.goto('/');

  await expect(page.getByTestId('power-toggle')).toBeVisible();
  await expect(page.getByTestId('server-card-2')).toBeVisible();

  const hasNoDocumentOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1
  );

  expect(hasNoDocumentOverflow).toBe(true);
});
