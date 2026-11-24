#!/usr/bin/env node
/**
 * Browser smoke test for the built site.
 *
 * The archive and style unit tests prove that the data exists. This test
 * proves the real MapLibre viewer loads it: it starts `vite preview`, launches
 * headless Chrome over the DevTools protocol, opens the map at z6, and asks
 * MapLibre which features are actually rendered.
 *
 * Requirements:
 *   - `npm run build` has produced dist/ with the vector and terrain archives
 *   - Google Chrome or Chromium is installed (override with CHROME_PATH)
 *
 * Usage: node map-build/scripts/browser-smoke.mjs
 */

import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.PREVIEW_PORT ?? 4179);
const EXTERNAL_BASE_URL = process.env.SMOKE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}/`;
const MAP_URL = new URL("?debug-map=1#map=6/38.9998/-105.543", BASE_URL).href;
const MOBILE_URL = new URL(
  "?debug-map=1&mobile=1#map=6/38.9998/-105.543",
  BASE_URL,
).href;
const LAYER_IDS = [
  "boundary-admin1",
  "road-minor",
  "road-secondary",
  "road-major",
  "railway",
  "urban",
  "park",
  "hillshade",
  "forest",
  "wetland",
  "glacier",
  "reef",
  "water-label",
  "waterway-label",
  "marine-label",
  "physio-label",
  "peak-dot",
  "peak-label",
  "airport-dot",
  "airport-label",
  "port-dot",
  "port-label",
  "place-region",
];
const URL_STATE_EXPRESSION = `(() => {
  const hash = window.location.hash;
  if (!hash.startsWith("#map=")) return null;
  const parts = hash.slice(5).split("/");
  if (parts.length !== 3) return null;
  const zoom = Number(parts[0]);
  const latitude = Number(parts[1]);
  const longitude = Number(parts[2]);
  if (![zoom, latitude, longitude].every(Number.isFinite)) return null;
  return {
    zoom,
    latitude,
    longitude,
    orientation: new URLSearchParams(window.location.search).get("orientation"),
  };
})()`;

function fail(message) {
  throw new Error(message);
}

function onPath(command) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const found = candidate.includes("/")
      ? existsSync(candidate)
        ? candidate
        : undefined
      : onPath(candidate);
    if (found) return found;
  }
  fail(
    "Chrome/Chromium was not found. Set CHROME_PATH to an executable browser.",
  );
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await sleep(200);
  }
  fail(`Timed out waiting for ${url}`);
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return true;
    } catch {
      // Chrome is still creating its debugging endpoint.
    }
    await sleep(200);
  }
  return false;
}

async function findPageTarget(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page =
        targets.find(
          (target) => target.type === "page" && target.url === "about:blank",
        ) ?? targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The page target may not be listed yet.
    }
    await sleep(200);
  }
  return undefined;
}

function connectCdp(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  const pending = new Map();
  const consoleErrors = [];
  const failures = [];
  const responses = [];
  let nextId = 0;

  const opened = new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", rejectOpen, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: resolveCall, reject: rejectCall } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectCall(new Error(JSON.stringify(message.error)));
      else resolveCall(message.result);
      return;
    }
    if (message.method === "Network.responseReceived") {
      responses.push({
        url: message.params.response.url,
        status: message.params.response.status,
      });
    }
    if (message.method === "Network.loadingFailed") {
      failures.push(message.params.errorText);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(
        message.params.args
          .map((argument) => argument.value ?? argument.description ?? "")
          .join(" "),
      );
    }
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    }
  });

  function send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolveCall, rejectCall) => {
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  async function waitFor(expression, label, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
      lastValue = await evaluate(expression);
      if (lastValue) return lastValue;
      await sleep(200);
    }
    fail(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
  }

  return {
    opened,
    send,
    evaluate,
    waitFor,
    consoleErrors,
    failures,
    responses,
    close: () => ws.close(),
  };
}

async function run() {
  const external = Boolean(EXTERNAL_BASE_URL);
  if (external) {
    console.log(`Testing deployed site: ${BASE_URL}`);
  } else {
    const viteBin = join(ROOT, "node_modules/vite/bin/vite.js");
    if (!existsSync(viteBin)) {
      fail("Vite is not installed. Run npm ci first.");
    }
    if (!existsSync(join(ROOT, "dist/index.html"))) {
      fail("dist/ is missing. Run npm run build before the browser smoke test.");
    }
  }

  const preview = external
    ? undefined
    : spawn(
        process.execPath,
        [
          join(ROOT, "node_modules/vite/bin/vite.js"),
          "preview",
          "--port",
          String(PORT),
          "--strictPort",
          "--host",
          "127.0.0.1",
        ],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
  let previewLog = "";
  preview?.stdout.on("data", (chunk) => {
    previewLog += chunk;
  });
  preview?.stderr.on("data", (chunk) => {
    previewLog += chunk;
  });

  const profiles = [];
  let chrome;
  let cdp;
  let chromeLog = "";

  try {
    await waitForHttp(BASE_URL, 20_000);

    const chromePath = findChrome();
    let debugPort;
    for (let attempt = 1; attempt <= 2 && !debugPort; attempt += 1) {
      const profile = mkdtempSync(join(tmpdir(), "south-up-smoke-"));
      profiles.push(profile);
      const port = await freePort();
      const child = spawn(
        chromePath,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-extensions",
          "--no-sandbox",
          "--use-angle=swiftshader-webgl",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          "--window-size=1280,900",
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      child.stderr?.on("data", (chunk) => {
        chromeLog += chunk;
      });
      chrome = child;

      if (await waitForDevTools(port, 15_000)) {
        debugPort = port;
        break;
      }

      child.kill("SIGTERM");
      chrome = undefined;
      await sleep(300);
    }

    if (!chrome || !debugPort) {
      fail(
        `Chrome did not expose a DevTools port after two attempts.\n` +
          `Chrome log:\n${chromeLog || "(no stderr)"}\nPreview log:\n${previewLog}`,
      );
    }

    const page = await findPageTarget(debugPort);
    if (!page?.webSocketDebuggerUrl) {
      fail(`Chrome has no page target. Chrome log:\n${chromeLog}`);
    }

    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Page.navigate", { url: MAP_URL });

    const splash = await cdp.waitFor(
      `(() => {
        const element = document.querySelector("#splash");
        if (!element || element.classList.contains("splash--hidden")) return null;
        const bar = element.querySelector(".splash__progress-bar");
        if (!bar) return null;
        const style = getComputedStyle(element);
        const barStyle = getComputedStyle(bar);
        const barRect = bar.getBoundingClientRect();
        if (
          !style.backgroundImage.includes("gradient") ||
          barStyle.animationName === "none" ||
          barRect.width <= 0 ||
          barRect.height <= 0
        ) {
          return null;
        }
        return {
          backgroundImage: style.backgroundImage,
          backgroundColor: style.backgroundColor,
          progressAnimation: barStyle.animationName,
          progressWidth: barRect.width,
          progressHeight: barRect.height,
        };
      })()`,
      "splash background and progress bar",
      5_000,
    );
    if (!splash.backgroundImage.includes("gradient")) {
      fail(`The splash has no background: ${JSON.stringify(splash)}`);
    }
    if (
      splash.progressAnimation === "none" ||
      splash.progressWidth <= 0 ||
      splash.progressHeight <= 0
    ) {
      fail(`The splash progress bar is not animating: ${JSON.stringify(splash)}`);
    }

    await cdp.waitFor(
      'document.querySelector("#map")?.dataset.ready === "true"',
      "map ready",
      20_000,
    );
    const initialUrl = await cdp.waitFor(
      URL_STATE_EXPRESSION,
      "initial URL state",
      5_000,
    );

    const report = await cdp.waitFor(
      `(() => {
        const map = window.__southUpMap;
        if (!map || !map.loaded()) return null;
        const count = (layers) => map.queryRenderedFeatures({ layers }).length;
        const regions = count(["place-region"]);
        if (regions === 0) return null;
        if (!map.isSourceLoaded("hillshade") || !map.isSourceLoaded("forest")) return null;
        return {
          zoom: map.getZoom(),
          styleLoaded: map.isStyleLoaded(),
          overlays: {
            hillshade: map.isSourceLoaded("hillshade"),
            forest: map.isSourceLoaded("forest"),
          },
          layers: Object.fromEntries(
            ${JSON.stringify(LAYER_IDS)}.map((id) => [id, Boolean(map.getLayer(id))]),
          ),
          rendered: {
            roads: count(["road-major", "road-secondary"]),
            railway: count(["railway"]),
            admin1: count(["boundary-admin1"]),
            regions,
            urban: count(["urban"]),
            parks: count(["park"]),
            airports: count(["airport-dot"]),
          },
          regionSource: map
            .querySourceFeatures("world", { sourceLayer: "place" })
            .filter((feature) => feature.properties.kind === "region").length,
        };
      })()`,
      "rendered detail layers",
      30_000,
    );

    const missingLayers = Object.entries(report.layers)
      .filter(([, present]) => !present)
      .map(([id]) => id);
    if (missingLayers.length > 0) {
      fail(`Style layers missing in the browser: ${missingLayers.join(", ")}`);
    }
    if (Math.abs(report.zoom - 6) > 0.01) {
      fail(`Expected z6, got z${report.zoom}`);
    }
    if (report.rendered.roads === 0) fail("No road features were rendered.");
    if (report.rendered.railway === 0) fail("No railway features were rendered.");
    if (report.rendered.admin1 === 0) fail("No Admin 1 boundaries were rendered.");
    if (report.rendered.regions === 0) fail("No Admin 1 labels were rendered.");
    if (report.regionSource === 0) fail("The place source has no region labels.");
    if (report.rendered.urban === 0) fail("No urban areas were rendered.");
    if (report.rendered.parks === 0) fail("No parks were rendered.");
    if (report.rendered.airports === 0) fail("No airports were rendered.");
    if (!report.overlays.hillshade || !report.overlays.forest) {
      fail(`The terrain overlays did not load: ${JSON.stringify(report.overlays)}`);
    }
    if (
      Math.abs(initialUrl.zoom - 6) > 0.01 ||
      Math.abs(initialUrl.latitude - 38.9998) > 0.05 ||
      Math.abs(initialUrl.longitude + 105.543) > 0.05 ||
      initialUrl.orientation !== null
    ) {
      fail(`Unexpected initial URL state: ${JSON.stringify(initialUrl)}`);
    }

    const readout = await cdp.waitFor(
      `(() => {
        const element = document.querySelector("#map-readout");
        if (!element || element.hidden) return null;
        const coordinates = document.querySelector("#map-coordinates")?.textContent ?? "";
        const scale = document.querySelector("#map-scale-label")?.textContent ?? "";
        const bar = document.querySelector("#map-scale-bar")?.getBoundingClientRect();
        if (!coordinates || !scale || !bar || bar.width <= 0 || bar.height <= 0) return null;
        return {
          coordinates,
          scale,
          barWidth: bar.width,
          ariaLabel: element.getAttribute("aria-label"),
        };
      })()`,
      "map readout",
      5_000,
    );
    if (!readout.coordinates.includes("°") || !readout.ariaLabel?.includes("scale")) {
      fail(`Unexpected map readout: ${JSON.stringify(readout)}`);
    }

    await cdp.evaluate('document.querySelector("#legend-button")?.click()');
    const legend = await cdp.waitFor(
      `(() => {
        const panel = document.querySelector("#legend-panel");
        const button = document.querySelector("#legend-button");
        if (!panel || panel.hidden) return null;
        return {
          expanded: button?.getAttribute("aria-expanded"),
          focused: document.activeElement?.id ?? null,
          entries: [...panel.querySelectorAll(".legend strong")].map(
            (entry) => entry.textContent ?? "",
          ),
          toggles: [...panel.querySelectorAll(".legend__checkbox")].map(
            (input) => ({
              id: input.id,
              checked: input instanceof HTMLInputElement && input.checked,
            }),
          ),
        };
      })()`,
      "legend panel",
      3_000,
    );
    if (
      legend.expanded !== "true" ||
      legend.focused !== "legend-close" ||
      ![
        "Glacier",
        "Terrain",
        "Forest",
        "Wetland",
        "Ocean & sea",
        "Physical region",
        "Peak",
      ].every((entry) => legend.entries.includes(entry))
    ) {
      fail(`Unexpected legend contents: ${JSON.stringify(legend)}`);
    }
    const toggleIds = [
      "overlay-hillshade",
      "overlay-forest",
      "overlay-wetland",
    ];
    if (
      legend.toggles.length !== toggleIds.length ||
      !toggleIds.every((id) =>
        legend.toggles.some((toggle) => toggle.id === id && toggle.checked),
      )
    ) {
      fail(`Unexpected overlay toggles: ${JSON.stringify(legend.toggles)}`);
    }

    const toggled = await cdp.evaluate(`(() => {
      const map = window.__southUpMap;
      if (!map || !map.loaded()) return null;
      const pairs = [
        ["hillshade", "overlay-hillshade"],
        ["forest", "overlay-forest"],
        ["wetland", "overlay-wetland"],
      ];
      const before = pairs.map(
        ([layer]) => map.getLayoutProperty(layer, "visibility") ?? "visible",
      );
      for (const [, id] of pairs) {
        const input = document.getElementById(id);
        if (!(input instanceof HTMLInputElement) || !input.checked) return null;
        input.click();
      }
      const hidden = pairs.map(
        ([layer]) => map.getLayoutProperty(layer, "visibility") ?? "visible",
      );
      for (const [, id] of pairs) document.getElementById(id)?.click();
      const restored = pairs.map(
        ([layer]) => map.getLayoutProperty(layer, "visibility") ?? "visible",
      );
      // Leave wetlands hidden across the orientation switch to prove the
      // legend state survives a new style, then restore it below.
      document.getElementById("overlay-wetland")?.click();
      return { before, hidden, restored };
    })()`);
    if (!toggled) fail("Could not exercise the overlay toggles.");
    const noBlank = (values) => values.every((value) => value !== "none");
    if (!noBlank(toggled.before) || !noBlank(toggled.restored)) {
      fail(`Overlay layers were not initially visible: ${JSON.stringify(toggled)}`);
    }
    if (!toggled.hidden.every((value) => value === "none")) {
      fail(`Overlay toggles did not hide their layers: ${JSON.stringify(toggled)}`);
    }

    await cdp.evaluate('document.querySelector("#legend-close")?.click()');
    await cdp.waitFor(
      'document.querySelector("#legend-panel")?.hidden === true && document.querySelector("#legend-button")?.getAttribute("aria-expanded") === "false"',
      "legend closed",
      3_000,
    );

    await cdp.evaluate(`(() => {
      window.__sharedData = null;
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data) => {
          window.__sharedData = data;
        },
      });
      document.querySelector("#share-view")?.click();
      return true;
    })()`);
    const shared = await cdp.waitFor(
      `(() => {
        const status = document.querySelector("#share-status");
        if (!status || status.hidden || !status.textContent) return null;
        return {
          status: status.textContent,
          data: window.__sharedData,
          url: window.location.href,
        };
      })()`,
      "native share feedback",
      3_000,
    );
    if (shared.status !== "Link shared") {
      fail(`Unexpected native share feedback: ${JSON.stringify(shared)}`);
    }
    if (shared.data?.url !== shared.url || !shared.url.includes("#map=")) {
      fail(`The share sheet received the wrong view URL: ${JSON.stringify(shared)}`);
    }
    if (
      typeof shared.data?.text !== "string" ||
      !shared.data.text.startsWith("South is up over ") ||
      shared.data.text.length <= "South is up over .".length
    ) {
      fail(`The share sheet received no place caption: ${JSON.stringify(shared)}`);
    }

    await cdp.evaluate(`(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copiedText = text;
          },
        },
      });
      document.querySelector("#share-view")?.click();
      return true;
    })()`);
    const copied = await cdp.waitFor(
      `(() => {
        const status = document.querySelector("#share-status");
        if (!status || status.hidden || status.textContent !== "Link copied") {
          return null;
        }
        return {
          status: status.textContent,
          text: window.__copiedText,
          url: window.location.href,
        };
      })()`,
      "clipboard share fallback",
      3_000,
    );
    if (copied.text !== copied.url || !copied.url.includes("#map=")) {
      fail(`The clipboard fallback copied the wrong URL: ${JSON.stringify(copied)}`);
    }

    await cdp.evaluate('document.querySelector("#orientation-north")?.click()');
    const northUp = await cdp.waitFor(
      `(() => {
        const container = document.querySelector("#map");
        const map = window.__southUpMap;
        if (container?.dataset.orientation !== "north" || !map || !map.loaded()) {
          return null;
        }
        const roads = map.queryRenderedFeatures({
          layers: ["road-major", "road-secondary"],
        }).length;
        if (roads === 0) return null;
        if (!map.isSourceLoaded("hillshade") || !map.isSourceLoaded("forest")) return null;
        return {
          orientation: container.dataset.orientation,
          southPressed: document.querySelector("#orientation-south")?.getAttribute("aria-pressed"),
          northPressed: document.querySelector("#orientation-north")?.getAttribute("aria-pressed"),
          label: container.getAttribute("aria-label"),
          roads,
          railway: map.queryRenderedFeatures({ layers: ["railway"] }).length,
          overlays: true,
          wetlandVisibility: map.getLayoutProperty("wetland", "visibility") ?? "visible",
        };
      })()`,
      "north-up view",
      20_000,
    );
    if (northUp.southPressed !== "false" || northUp.northPressed !== "true") {
      fail("North-up orientation controls did not update.");
    }
    if (!northUp.label?.includes("north at the top")) {
      fail("North-up map label is missing.");
    }
    if (northUp.railway === 0) fail("North-up view rendered no railways.");
    if (northUp.wetlandVisibility !== "none") {
      fail("The wetland toggle did not survive the north-up style switch.");
    }
    const northUrl = await cdp.waitFor(
      `(() => {
        const state = ${URL_STATE_EXPRESSION};
        return state?.orientation === "north" ? state : null;
      })()`,
      "north-up URL state",
      5_000,
    );
    if (
      Math.abs(northUrl.latitude - 38.9998) > 0.05 ||
      Math.abs(northUrl.longitude + 105.543) > 0.05
    ) {
      fail(`North-up URL did not preserve real coordinates: ${JSON.stringify(northUrl)}`);
    }

    await cdp.evaluate('document.querySelector("#orientation-south")?.click()');
    const southUp = await cdp.waitFor(
      `(() => {
        const container = document.querySelector("#map");
        const map = window.__southUpMap;
        if (container?.dataset.orientation !== "south" || !map || !map.loaded()) {
          return null;
        }
        const roads = map.queryRenderedFeatures({
          layers: ["road-major", "road-secondary"],
        }).length;
        if (roads === 0) return null;
        return {
          orientation: container.dataset.orientation,
          southPressed: document.querySelector("#orientation-south")?.getAttribute("aria-pressed"),
          northPressed: document.querySelector("#orientation-north")?.getAttribute("aria-pressed"),
          roads,
          wetlandVisibility: map.getLayoutProperty("wetland", "visibility") ?? "visible",
        };
      })()`,
      "south-up view restored",
      20_000,
    );
    if (southUp.southPressed !== "true" || southUp.northPressed !== "false") {
      fail("South-up orientation controls did not update after switching back.");
    }
    if (southUp.wetlandVisibility !== "none") {
      fail("The wetland toggle did not survive the south-up style switch.");
    }
    await cdp.evaluate('document.querySelector("#overlay-wetland")?.click()');
    const wetlandRestored = await cdp.waitFor(
      `(() => {
        const map = window.__southUpMap;
        const input = document.querySelector("#overlay-wetland");
        if (!map || !(input instanceof HTMLInputElement)) return null;
        const visibility = map.getLayoutProperty("wetland", "visibility") ?? "visible";
        return visibility === "none" || !input.checked ? null : visibility;
      })()`,
      "wetland visibility restored",
      3_000,
    );
    if (wetlandRestored === "none") fail("The wetland toggle did not restore.");
    const southUrl = await cdp.waitFor(
      `(() => {
        const state = ${URL_STATE_EXPRESSION};
        return state?.orientation === null ? state : null;
      })()`,
      "south-up URL state",
      5_000,
    );
    if (
      Math.abs(southUrl.latitude - 38.9998) > 0.05 ||
      Math.abs(southUrl.longitude + 105.543) > 0.05
    ) {
      fail(`South-up URL did not preserve real coordinates: ${JSON.stringify(southUrl)}`);
    }

    await cdp.evaluate(`(() => {
      const map = window.__southUpMap;
      if (!map) return false;
      map.jumpTo({ center: [-105.543, -38.9998], zoom: 4 });
      return true;
    })()`);
    const lowZoom = await cdp.waitFor(
      `(() => {
        const map = window.__southUpMap;
        if (!map || !map.loaded() || Math.abs(map.getZoom() - 4) > 0.01) return null;
        const boundaries = map.queryRenderedFeatures({
          layers: ["boundary-admin1"],
        }).length;
        const regions = map.queryRenderedFeatures({ layers: ["place-region"] }).length;
        if (boundaries === 0 || regions === 0) return null;
        return { boundaries, regions };
      })()`,
      "z4 Admin 1 boundaries and labels",
      20_000,
    );
    if (lowZoom.boundaries === 0 || lowZoom.regions === 0) {
      fail(`The z4 Admin 1 selection is empty: ${JSON.stringify(lowZoom)}`);
    }

    const setSearchValue = async (value) => {
      await cdp.evaluate(`(() => {
        const input = document.querySelector("#search-input");
        if (!(input instanceof HTMLInputElement)) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
    };
    const pressSearchKey = async (key) => {
      await cdp.evaluate(`(() => {
        const input = document.querySelector("#search-input");
        if (!(input instanceof HTMLInputElement)) return false;
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }),
        );
        return true;
      })()`);
    };

    await setSearchValue("Paris");
    const placeResult = await cdp.waitFor(
      `(() => {
        const title = document.querySelector("#search-result-0 .search__result-title")?.textContent;
        if (!title) return null;
        return {
          title,
          detail: document.querySelector("#search-result-0 .search__result-detail")?.textContent,
        };
      })()`,
      "place search result",
      5_000,
    );
    if (placeResult.title !== "Paris" || !placeResult.detail?.includes("France")) {
      fail(`Unexpected place search result: ${JSON.stringify(placeResult)}`);
    }

    await pressSearchKey("ArrowDown");
    const activeResult = await cdp.evaluate(
      'document.querySelector("#search-result-0")?.getAttribute("aria-selected")',
    );
    if (activeResult !== "true") fail("ArrowDown did not select the first search result.");

    await pressSearchKey("Enter");
    await cdp.waitFor(
      'document.querySelector("#search-input")?.value === "Paris" && document.querySelector("#search-results")?.hidden === true',
      "place selection",
      5_000,
    );
    const placeMap = await cdp.waitFor(
      `(() => {
        const map = window.__southUpMap;
        if (!map || map.isMoving() || map.getZoom() < 8.5) return null;
        const center = map.getCenter();
        return { zoom: map.getZoom(), lat: center.lat, lng: center.lng };
      })()`,
      "place search flight",
      15_000,
    );
    if (Math.abs(placeMap.lat + 48.8566) > 0.75 || Math.abs(placeMap.lng - 2.3522) > 0.75) {
      fail(`Search did not fly to Paris: ${JSON.stringify(placeMap)}`);
    }
    const parisReadout = await cdp.waitFor(
      `(() => {
        const coordinates = document.querySelector("#map-coordinates")?.textContent ?? "";
        const scale = document.querySelector("#map-scale-label")?.textContent ?? "";
        if (!coordinates.includes("48.8") || !scale) return null;
        return { coordinates, scale };
      })()`,
      "Paris readout",
      10_000,
    );
    const placeUrl = await cdp.waitFor(
      `(() => {
        const state = ${URL_STATE_EXPRESSION};
        return state && Math.abs(state.zoom - 9) < 0.05 ? state : null;
      })()`,
      "place URL state",
      5_000,
    );
    if (
      Math.abs(placeUrl.latitude - 48.8566) > 0.05 ||
      Math.abs(placeUrl.longitude - 2.3522) > 0.05 ||
      placeUrl.orientation !== null
    ) {
      fail(`Place URL did not keep real southern-up coordinates: ${JSON.stringify(placeUrl)}`);
    }

    await setSearchValue("48.8566, 2.3522");
    const coordinateResult = await cdp.waitFor(
      `(() => {
        const title = document.querySelector("#search-result-0 .search__result-title")?.textContent;
        if (!title) return null;
        return {
          title,
          detail: document.querySelector("#search-result-0 .search__result-detail")?.textContent,
        };
      })()`,
      "coordinate search result",
      5_000,
    );
    if (
      coordinateResult.title !== "48.8566, 2.3522" ||
      !coordinateResult.detail?.includes("Coordinates")
    ) {
      fail(`Unexpected coordinate search result: ${JSON.stringify(coordinateResult)}`);
    }
    await pressSearchKey("Enter");
    await cdp.waitFor(
      'document.querySelector("#search-input")?.value === "48.8566, 2.3522" && document.querySelector("#search-results")?.hidden === true',
      "coordinate selection",
      5_000,
    );
    const coordinateUrl = await cdp.waitFor(
      `(() => {
        const state = ${URL_STATE_EXPRESSION};
        return state && Math.abs(state.zoom - 10) < 0.05 ? state : null;
      })()`,
      "coordinate URL state",
      5_000,
    );
    if (
      Math.abs(coordinateUrl.latitude - 48.8566) > 0.05 ||
      Math.abs(coordinateUrl.longitude - 2.3522) > 0.05
    ) {
      fail(`Coordinate URL is wrong: ${JSON.stringify(coordinateUrl)}`);
    }

    await setSearchValue("no-such-place-xyz");
    const emptyState = await cdp.waitFor(
      `(() => {
        const list = document.querySelector("#search-results");
        const status = document.querySelector("#search-status");
        if (!list || !status || !list.hidden || status.hidden) return null;
        if (!status.textContent?.includes("No matching place")) return null;
        return { listHidden: list.hidden, status: status.textContent };
      })()`,
      "search empty state",
      5_000,
    );
    await pressSearchKey("Escape");
    const escapedSearch = await cdp.waitFor(
      `(() => {
        const input = document.querySelector("#search-input");
        const list = document.querySelector("#search-results");
        const status = document.querySelector("#search-status");
        if (!input || !list || !status) return null;
        if (!list.hidden || !status.hidden || input.getAttribute("aria-expanded") !== "false") {
          return null;
        }
        return {
          listHidden: list.hidden,
          statusHidden: status.hidden,
          expanded: input.getAttribute("aria-expanded"),
          blurred: document.activeElement !== input,
        };
      })()`,
      "Escape closing the search",
      5_000,
    );
    if (!escapedSearch.blurred) fail("Escape did not blur the search input.");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    // Drop the old handle so the next wait cannot pass on the previous page's
    // already-ready DOM during navigation.
    await cdp.evaluate("delete window.__southUpMap");
    // A different query string (not just a different hash) forces a full
    // document load, so the map is rebuilt at the mobile viewport.
    await cdp.send("Page.navigate", { url: MOBILE_URL });
    await cdp.waitFor(
      `(() => {
        const map = window.__southUpMap;
        return (
          innerWidth === 390 &&
          document.querySelector("#map")?.dataset.ready === "true" &&
          map &&
          Math.abs(map.getZoom() - 6) < 0.01
        );
      })()`,
      "mobile map ready",
      20_000,
    );
    const mobile = await cdp.waitFor(
      `(() => {
        const map = window.__southUpMap;
        if (!map || !map.loaded()) return null;
        const roads = map.queryRenderedFeatures({
          layers: ["road-major", "road-secondary"],
        }).length;
        const admin1 = map.queryRenderedFeatures({ layers: ["boundary-admin1"] }).length;
        const readout = document.querySelector("#map-readout");
        if (!readout || readout.hidden) return null;
        if (roads === 0 || admin1 === 0) return null;
        const selectors = [
          "#search-input",
          "#orientation-south",
          "#orientation-north",
          "#zoom-in",
          "#zoom-out",
          "#share-view",
          "#info-button",
          "#map-readout",
        ];
        const controls = selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, present: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            selector,
            present: true,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            display: style.display,
            visibility: style.visibility,
          };
        });
        const controlsInsideViewport = controls.every(
          (control) =>
            control.present &&
            control.width > 0 &&
            control.height > 0 &&
            control.display !== "none" &&
            control.visibility !== "hidden" &&
            control.left >= -1 &&
            control.top >= -1 &&
            control.right <= innerWidth + 1 &&
            control.bottom <= innerHeight + 1,
        );
        const canvas = document.querySelector(".maplibregl-canvas")?.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          controlsInsideViewport,
          controls,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          canvas: canvas
            ? {
                left: canvas.left,
                top: canvas.top,
                right: canvas.right,
                bottom: canvas.bottom,
                width: canvas.width,
                height: canvas.height,
              }
            : null,
          roads,
          admin1,
        };
      })()`,
      "mobile viewport",
      20_000,
    );
    if (!mobile.controlsInsideViewport) {
      fail(`A map control is outside the mobile viewport: ${JSON.stringify(mobile.controls)}`);
    }
    if (mobile.horizontalOverflow) fail("The mobile viewport has horizontal overflow.");
    if (!mobile.canvas || mobile.canvas.width < 380 || mobile.canvas.height < 830) {
      fail(`The mobile map canvas does not fill the viewport: ${JSON.stringify(mobile.canvas)}`);
    }
    if (mobile.admin1 === 0) fail("The mobile viewport rendered no Admin 1 boundaries.");

    const findFeaturePoint = async (layers, label) =>
      cdp.waitFor(
        `(async () => {
          const map = window.__southUpMap;
          if (!map || !map.loaded()) return null;
          const requested = ${JSON.stringify(layers)};
          const allLayers = [
            "place-country",
            "place-capital-dot",
            "place-capital",
            "place-city-dot",
            "place-city",
            "place-town",
            "place-region",
            "airport-dot",
            "airport-label",
            "port-dot",
            "port-label",
            "park",
            "wetland",
            "marine-label",
            "physio-label",
            "peak-dot",
            "peak-label",
          ];
          const features = map.queryRenderedFeatures({ layers: allLayers });
          const topAt = (x, y) => {
            const exact = map.queryRenderedFeatures([x, y], { layers: allLayers });
            return exact.length
              ? exact
              : map.queryRenderedFeatures(
                  [
                    [x - 6, y - 6],
                    [x + 6, y + 6],
                  ],
                  { layers: allLayers },
                );
          };
          for (const feature of features) {
            const name = feature.properties?.name;
            if (!name || !requested.includes(feature.layer?.id)) continue;
            const geometry = feature.geometry;
            const coordinates = [];
            if (geometry.type === "Point") {
              coordinates.push(geometry.coordinates);
            } else if (geometry.type === "MultiPoint") {
              coordinates.push(...geometry.coordinates);
            } else if (geometry.type === "Polygon") {
              coordinates.push(...geometry.coordinates[0]);
            } else if (geometry.type === "MultiPolygon") {
              for (const polygon of geometry.coordinates) {
                coordinates.push(...polygon[0]);
              }
            }
            for (const coordinate of coordinates) {
              const projected = map.project(coordinate);
              // Hit-test the exact pixel that will be clicked, with the same
              // fallback the app uses. Testing the unrounded projection can
              // pick a feature that the click then resolves to its neighbour.
              const x = Math.round(projected.x);
              const y = Math.round(projected.y);
              if (x < 24 || y < 130 || x > innerWidth - 24 || y > innerHeight - 120) {
                continue;
              }
              const hits = topAt(x, y);
              if (
                hits[0]?.layer?.id !== feature.layer?.id ||
                hits[0]?.properties?.name !== name
              ) {
                continue;
              }
              // Labels can be placed a frame or two after a tile loads. Let the
              // placement settle and confirm the click still resolves here.
              await new Promise((resolve) => setTimeout(resolve, 250));
              const settled = topAt(x, y);
              if (
                settled[0]?.layer?.id !== feature.layer?.id ||
                settled[0]?.properties?.name !== name
              ) {
                continue;
              }
              return {
                x,
                y,
                name,
                layer: feature.layer?.id,
              };
            }
          }
          return null;
        })()`,
        `${label} rendered feature`,
        15_000,
      );

    const clickMapAt = async (point) => {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
    };

    const inspectFeature = async (layers, eyebrow) => {
      const point = await findFeaturePoint(layers, eyebrow.toLowerCase());
      await clickMapAt(point);
      const card = await cdp.waitFor(
        `(() => {
          const element = document.querySelector("#feature-card");
          if (!element || element.hidden) return null;
          const terms = [...document.querySelectorAll("#feature-card-facts dt")];
          const values = [...document.querySelectorAll("#feature-card-facts dd")];
          const rect = element.getBoundingClientRect();
          return {
            title: document.querySelector("#feature-card-title")?.textContent ?? "",
            eyebrow: document.querySelector("#feature-card-eyebrow")?.textContent ?? "",
            subtitle: document.querySelector("#feature-card-subtitle")?.textContent ?? "",
            facts: terms.map((term, index) => ({
              label: term.textContent,
              value: values[index]?.textContent ?? "",
            })),
            focused: document.activeElement?.id ?? null,
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
            viewport: { width: innerWidth, height: innerHeight },
          };
        })()`,
        `${eyebrow} card`,
        5_000,
      );
      if (card.title !== point.name) {
        fail(`The ${eyebrow} card has the wrong title: ${JSON.stringify({ point, card })}`);
      }
      if (card.eyebrow !== eyebrow) {
        fail(`Expected a ${eyebrow} card, got ${JSON.stringify(card)}`);
      }
      if (card.focused !== "feature-card-close") {
        fail(`The ${eyebrow} card did not move focus to its close button.`);
      }
      if (
        card.rect.width <= 0 ||
        card.rect.height <= 0 ||
        card.rect.left < -1 ||
        card.rect.top < -1 ||
        card.rect.right > card.viewport.width + 1 ||
        card.rect.bottom > card.viewport.height + 1
      ) {
        fail(`The ${eyebrow} card is outside the viewport: ${JSON.stringify(card.rect)}`);
      }
      return card;
    };

    const closeFeatureCard = async () => {
      await cdp.evaluate('document.querySelector("#feature-card-close")?.click()');
      await cdp.waitFor(
        'document.querySelector("#feature-card")?.hidden === true',
        "feature card closed",
        2_000,
      );
    };

    const placeCard = await inspectFeature(
      ["place-capital", "place-city", "place-town", "place-region"],
      "Place",
    );
    await closeFeatureCard();
    const airportCard = await inspectFeature(
      ["airport-dot", "airport-label"],
      "Airport",
    );
    await closeFeatureCard();
    const parkCard = await inspectFeature(["park"], "Park");
    await closeFeatureCard();

    await cdp.evaluate(`(() => {
      window.__southUpMap?.jumpTo({ center: [4.4, -51.9], zoom: 6 });
      return true;
    })()`);
    const portCard = await inspectFeature(["port-dot", "port-label"], "Port");
    await closeFeatureCard();

    await cdp.evaluate('document.querySelector("#orientation-north")?.click()');
    await cdp.waitFor(
      'document.querySelector("#map")?.dataset.orientation === "north"',
      "north-up card view",
      20_000,
    );
    const northPortCard = await inspectFeature(
      ["port-dot", "port-label"],
      "Port",
    );
    const northCoordinates = northPortCard.facts.find(
      (fact) => fact.label === "Coordinates",
    )?.value;
    if (!northCoordinates?.includes("° N")) {
      fail(`North-up card has the wrong real coordinates: ${JSON.stringify(northPortCard)}`);
    }
    await cdp.evaluate(
      'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))',
    );
    await cdp.waitFor(
      'document.querySelector("#feature-card")?.hidden === true',
      "feature card closed with Escape",
      2_000,
    );

    await cdp.evaluate(`(() => {
      window.__southUpMap?.jumpTo({ center: [86.925, 27.988], zoom: 6 });
      return true;
    })()`);
    const peakCard = await inspectFeature(["peak-dot", "peak-label"], "Elevation");
    const elevation = peakCard.facts.find((fact) => fact.label === "Elevation")?.value;
    if (!elevation?.includes(" m")) {
      fail(`Peak card has no elevation: ${JSON.stringify(peakCard)}`);
    }
    await closeFeatureCard();

    await cdp.evaluate(`(() => {
      window.__southUpMap?.jumpTo({ center: [-30, 40], zoom: 2 });
      return true;
    })()`);
    const marineCard = await inspectFeature(["marine-label"], "Water body");
    await closeFeatureCard();

    await cdp.evaluate(`(() => {
      window.__southUpMap?.jumpTo({ center: [13, 23], zoom: 3 });
      return true;
    })()`);
    const physioCard = await inspectFeature(["physio-label"], "Physical region");
    await closeFeatureCard();

    await cdp.evaluate(`(() => {
      window.__southUpMap?.jumpTo({ center: [145.5, -15], zoom: 6 });
      return true;
    })()`);
    const reefCount = await cdp.waitFor(
      `(() => {
        const map = window.__southUpMap;
        if (!map || !map.loaded()) return null;
        return map.queryRenderedFeatures({ layers: ["reef"] }).length || null;
      })()`,
      "coral reef layer",
      20_000,
    );

    await cdp.evaluate(`(() => {
      window.__southUpMap?.jumpTo({ center: [0, 0], zoom: 0 });
      return true;
    })()`);
    const globalDetail = await cdp.waitFor(
      `(() => {
        const map = window.__southUpMap;
        if (!map || !map.loaded()) return null;
        const glacier = map.queryRenderedFeatures({ layers: ["glacier"] }).length;
        const marine = map.queryRenderedFeatures({ layers: ["marine-label"] }).length;
        const wetland = map
          .querySourceFeatures("world", { sourceLayer: "wetland" })
          .length;
        if (glacier === 0 || marine === 0 || wetland === 0) return null;
        return { glacier, marine, wetland };
      })()`,
      "glacier and marine labels at world scale",
      20_000,
    );

    const failures = cdp.failures.filter((failure) => !failure.includes("ERR_ABORTED"));
    const pmtilesResponses = cdp.responses.filter((response) =>
      response.url.includes("world.pmtiles"),
    );
    const overlayResponses = cdp.responses.filter((response) =>
      /(hillshade|forest)-(south|north)\.pmtiles/.test(response.url),
    );
    const summary = {
      splash,
      legend,
      readout: { initial: readout, paris: parisReadout },
      reefCount,
      overlays: report.overlays,
      detailLayers: report.rendered,
      globalDetail,
      northUp: {
        orientation: northUp.orientation,
        roads: northUp.roads,
        railway: northUp.railway,
      },
      southUp: { orientation: southUp.orientation, roads: southUp.roads },
      search: {
        place: placeResult,
        coordinate: coordinateResult,
        keyboardSelected: activeResult === "true",
        placeZoom: placeMap.zoom,
        emptyState,
        escapeClosed: escapedSearch,
      },
      urlState: {
        initial: initialUrl,
        north: northUrl,
        south: southUrl,
        place: placeUrl,
        coordinate: coordinateUrl,
      },
      share: {
        native: shared.status,
        clipboard: copied.status,
        caption: shared.data?.text,
      },
      mobile,
      featureCards: {
        place: placeCard,
        airport: airportCard,
        port: portCard,
        park: parkCard,
        northPort: northPortCard,
        peak: peakCard,
        marine: marineCard,
        physio: physioCard,
      },

      pmtilesRequests: pmtilesResponses.length,
      pmtilesStatuses: [...new Set(pmtilesResponses.map((response) => response.status))],
      overlayRequests: overlayResponses.length,
      overlayStatuses: [...new Set(overlayResponses.map((response) => response.status))],
      consoleErrors: cdp.consoleErrors,
      failedRequests: failures,
    };
    console.log(JSON.stringify(summary, null, 2));

    if (pmtilesResponses.length === 0) fail("The browser never requested world.pmtiles.");
    if (pmtilesResponses.some((response) => ![200, 206].includes(response.status))) {
      fail(`world.pmtiles returned an unexpected status: ${JSON.stringify(pmtilesResponses)}`);
    }
    if (overlayResponses.length === 0) fail("The browser never requested a terrain overlay.");
    if (overlayResponses.some((response) => ![200, 206].includes(response.status))) {
      fail(`A terrain overlay returned an unexpected status: ${JSON.stringify(overlayResponses)}`);
    }
    if (cdp.consoleErrors.length > 0) {
      fail(`Console errors: ${cdp.consoleErrors.join(" | ")}`);
    }
    if (failures.length > 0) {
      fail(`Failed browser requests: ${failures.join(" | ")}`);
    }

    console.log("BROWSER SMOKE TEST PASSED");
  } finally {
    cdp?.close();
    chrome?.kill("SIGTERM");
    preview?.kill("SIGTERM");
    await sleep(400);
    for (const profile of profiles) {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // Chrome may still be flushing its profile; the temp directory is safe
        // to leave behind and must not turn a passing test into a failure.
      }
    }
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    // Surface the failed assertion in the Actions summary without requiring
    // repository-admin access to the raw job log.
    console.log(`::error title=Browser smoke test::${message.replace(/\n/g, "%0A")}`);
  }
  process.exitCode = 1;
});
