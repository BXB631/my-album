const http = require('node:http');

const DEBUG_PORT = Number(process.env.CDP_PORT) || 9222;
const DEBUG_BASE = `http://127.0.0.1:${DEBUG_PORT}`;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const deadline = Date.now() + 30000;
  let page;

  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`${DEBUG_BASE}/json/list`);
      page = targets.find(
        (target) =>
          target.type === 'page' &&
          target.url.startsWith('http://127.0.0.1:')
      );
    } catch {
      // Electron is still starting.
    }

    if (page) {
      break;
    }

    await delay(500);
  }

  if (!page) {
    throw new Error('No Electron page appeared on the debugging port');
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);

    if (!request) {
      return;
    }

    pending.delete(message.id);
    request(message);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) => {
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text
      );
    }

    return result.result.value;
  };

  await send('Runtime.enable');

  const info = await evaluate(`
    (async () => {
      const started = performance.now();
      for (let i = 0; i < 60; i += 1) {
        if (document.querySelector('#gallery')?.dataset.state === 'ready') break;
        await new Promise((r) => setTimeout(r, 250));
      }

      const response = await fetch('/api/photos', { cache: 'no-store' });
      const library = await response.json();

      return {
        title: document.title,
        readyState: document.readyState,
        galleryState: document.querySelector('#gallery')?.dataset.state,
        summary: document.querySelector('#summary')?.textContent,
        cards: document.querySelectorAll('.media-card').length,
        imageCards: document.querySelectorAll('.media-card.is-image').length,
        dayGroups: document.querySelectorAll('.day-group').length,
        source: document.querySelector('#sourceName')?.textContent,
        apiTotal: library.total,
        apiImages: library.imageCount,
        apiVideos: library.videoCount,
        apiRoot: library.root,
        elapsedMs: Math.round(performance.now() - started),
      };
    })()
  `);

  const cardResult = await evaluate(`
    (async () => {
      const card = document.querySelector('.media-card.is-image');
      if (!card) return { clicked: false };
      card.click();

      let image;
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        image = document.querySelector('#viewerMedia img');
        if (image?.naturalWidth) break;
      }

      const viewer = document.querySelector('#viewer');
      return {
        clicked: true,
        viewerOpen: viewer?.getAttribute('aria-hidden') === 'false',
        hasImage: Boolean(image),
        imageWidth: image?.naturalWidth || 0,
        counter: document.querySelector('#viewerCounter')?.textContent,
      };
    })()
  `);

  const closeResult = await evaluate(`
    (async () => {
      document.querySelector('#viewerClose')?.click();
      await new Promise((r) => setTimeout(r, 400));
      return {
        viewerClosed:
          document.querySelector('#viewer')?.getAttribute('aria-hidden') === 'true',
      };
    })()
  `);

  const result = { ...info, ...cardResult, ...closeResult };

  const origin = new URL(page.url).origin;
  await send('Page.enable');
  await send('Page.navigate', { url: `${origin}/map.html` });
  await delay(3000);

  const mapResult = await evaluate(`
    ({
      title: document.title,
      leafletLoaded: Boolean(window.L),
      mapContainer: Boolean(document.querySelector('.leaflet-container')),
      mapSummary: document.querySelector('#mapSummaryText')?.textContent || '',
    })
  `);

  Object.assign(result, { map: mapResult });
  console.log(JSON.stringify(result, null, 2));

  const failures = [];

  if (result.title !== '我的相册') failures.push('unexpected window title');
  if (result.galleryState !== 'ready') failures.push('gallery did not become ready');
  if (!result.apiTotal) failures.push('photo API returned no items');
  if (!result.cards) failures.push('no photo cards rendered');
  if (result.clicked && !result.viewerOpen) failures.push('viewer did not open');
  if (result.clicked && !result.hasImage) failures.push('viewer image missing');
  if (result.clicked && !result.viewerClosed) failures.push('viewer did not close');
  if (!mapResult.leafletLoaded) failures.push('Leaflet did not load');
  if (!mapResult.mapContainer) failures.push('map container missing');

  socket.close();

  if (failures.length) {
    throw new Error(`Desktop smoke test failed: ${failures.join(', ')}`);
  }

  console.log('DESKTOP_SMOKE_TEST_OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
