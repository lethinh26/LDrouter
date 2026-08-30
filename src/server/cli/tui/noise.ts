/**
 * Zero-dependency interactive console UI for ldrouter.
 *
 * Raw stdin + ANSI escape codes only — no external dependencies. Boots the
 * real server (DB -> Fastify listen), then drives a menu:
 *   Open Dashboard / Check for Updates / Exit.
 */

import process from 'node:process';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { hideCursor, showCursor, home, eraseDown, color } from './ansi';
import { getAppVersion } from '../../version';
import { loadConfig, type RuntimeConfig } from '../../config/index';
import { buildApp } from '../../app';
import { closeDb } from '../../db/index';
import { getSelfUpdater, type CheckResult } from '../../selfupdate/index';

// Key sequences as escape literals (never raw control bytes in source).
const KEY = {
  up: '\x1B[A', // ESC [ A
  down: '\x1B[B', // ESC [ B
  enter: '\r',
  newline: '\n',
  space: ' ',
  ctrlC: '\x03', // Ctrl+C
  esc: '\x1B',    // Escape key
};

const WIDTH = 36;
const PAD = 2;

type Screen =
  | { name: 'menu' }
  | { name: 'check'; spinner: number }
  | { name: 'checkResult'; result: CheckResult; sel: number }
  | { name: 'applying'; spinner: number; to: string }
  | { name: 'updated'; from: string; to: string; sel: number }
  | { name: 'message'; title: string; lines: string[]; ok: boolean };

let cfg: RuntimeConfig;
let app: FastifyInstance | null = null;
let startedAt = Date.now();
let screen: Screen = { name: 'menu' };
let menuSel = 0;
let lastRender = '';

// ---------------------------------------------------------------- output

function out(s: string): void {
  process.stdout.write(s);
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function kv(label: string, value: string): string {
  return `${' '.repeat(PAD)}${color.gray}${label.padEnd(12)}${color.reset}${value}`;
}

function menuItem(label: string, selected: boolean): string {
  const marker = selected ? `${color.cyan}❯ ${color.reset}` : '  ';
  const text = selected ? `${color.cyan}${label}${color.reset}` : label;
  return `${' '.repeat(PAD)}${marker}${text}`;
}

function header(): string[] {
  return [
    `${color.cyan}${color.bold}LateDev Router${color.reset}`,
    `${color.gray}${'─'.repeat(WIDTH)}${color.reset}`,
    '',
  ];
}

function footer(): string {
  return `${' '.repeat(PAD)}${color.gray}↑↓ Navigate    Enter Select    q Exit${color.reset}`;
}

function spinnerFrame(tick: number): string {
  const frames = ['◐', '◓', '◑', '◒'];
  return frames[Math.floor(tick / 2) % frames.length] as string;
}

function renderMenu(): string {
  const url = `http://localhost:${cfg.port}`;
  const items = ['Open Dashboard', 'Check for Updates', 'Exit'];
  return [
    ...header(),
    `${color.green}● Server is running${color.reset}`,
    '',
    kv('Dashboard', url),
    kv('Version', `v${getAppVersion()}`),
    kv('Uptime', fmtUptime(Date.now() - startedAt)),
    '',
    ...items.map((label, i) => menuItem(label, i === menuSel)),
    '',
    footer(),
  ].join('\n');
}

function renderCheck(tick: number): string {
  return [
    ...header(),
    `${spinnerFrame(tick)} Checking for updates...`,
  ].join('\n');
}

function renderCheckResult(r: CheckResult, sel: number): string {
  const lines = [...header()];
  if (r.latestVersion === null) {
    lines.push(
      `${color.red}✗ Could not reach the update server${color.reset}`,
      '',
      kv('Version', `v${r.currentVersion}`),
      '',
      menuItem('Back', sel === 0),
    );
  } else if (r.hasUpdate) {
    lines.push(
      kv('Current', `v${r.currentVersion}`),
      kv('Latest', `v${r.latestVersion}`),
      '',
      `${color.green}New version available.${color.reset}`,
      '',
      menuItem(`Update to v${r.latestVersion}`, sel === 0),
      menuItem('Back', sel === 1),
    );
  } else {
    lines.push(
      `${color.green}✓ You're up to date${color.reset}`,
      '',
      kv('Version', `v${r.currentVersion}`),
      '',
      menuItem('Back', sel === 0),
    );
  }
  lines.push('', footer());
  return lines.join('\n');
}

function renderApplying(tick: number, to: string): string {
  return [
    ...header(),
    `${spinnerFrame(tick)} Updating to v${to}...`,
    '',
    `${' '.repeat(PAD)}${color.gray}Installing the new version with your package manager.${color.reset}`,
    `${' '.repeat(PAD)}${color.gray}The gateway restarts automatically.${color.reset}`,
  ].join('\n');
}

function renderUpdated(from: string, to: string, sel: number): string {
  return [
    ...header(),
    `${color.green}✓ LDRouter updated successfully${color.reset}`,
    '',
    `${' '.repeat(PAD)}v${from} → v${to}`,
    '',
    menuItem('Restart', sel === 0),
    menuItem('Exit', sel === 1),
    '',
    footer(),
  ].join('\n');
}

function renderMessage(title: string, lines: string[], ok: boolean): string {
  return [
    ...header(),
    `${ok ? color.green + '✓' : color.red + '✗'} ${title}${color.reset}`,
    ...lines.map((l) => `${' '.repeat(PAD)}${color.gray}${l}${color.reset}`),
    '',
    menuItem('Back', true),
    '',
    footer(),
  ].join('\n');
}

function draw(): void {
  let body: string;
  const s = screen;
  if (s.name === 'menu') body = renderMenu();
  else if (s.name === 'check') body = renderCheck(s.spinner);
  else if (s.name === 'checkResult') body = renderCheckResult(s.result, s.sel);
  else if (s.name === 'applying') body = renderApplying(s.spinner, s.to);
  else if (s.name === 'updated') body = renderUpdated(s.from, s.to, s.sel);
  else body = renderMessage(s.title, s.lines, s.ok);

  if (body === lastRender) return;
  lastRender = body;
  out(home + body + '\n' + eraseDown);
}

// ---------------------------------------------------------------- keys

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.once('data', (d) => resolve(d.toString('utf8')));
  });
}

// ---------------------------------------------------------------- helpers

function openUrl(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url.replace(/&/g, '^&')];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* spawn failed — surface as message upstream */
  }
}

function respawn(): void {
  // Re-exec this same CLI (preserves flags like --tui).
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    detached: true,
  });
  child.unref();
}

// ---------------------------------------------------------------- actions

async function openDashboard(): Promise<void> {
  const url = `http://localhost:${cfg.port}`;
  openUrl(url);
  screen = { name: 'message', title: 'Dashboard opened in your browser', lines: [url], ok: true };
}

async function runUpdateCheck(): Promise<void> {
  screen = { name: 'check', spinner: 0 };
  draw();
  const tick = setInterval(() => {
    if (screen.name === 'check') {
      screen.spinner++;
      draw();
    }
  }, 120);
  let result: CheckResult;
  try {
    result = await getSelfUpdater().check(true);
  } catch {
    result = {
      currentVersion: getAppVersion(),
      latestVersion: null,
      hasUpdate: false,
      changelogUrl: null,
      checkedAt: new Date().toISOString(),
      watchtowerReachable: null,
    };
  } finally {
    clearInterval(tick);
  }
  screen = { name: 'checkResult', result, sel: 0 };
  draw();
}

async function applyUpdate(result: CheckResult): Promise<void> {
  const to = result.latestVersion;
  if (!to) return;
  screen = { name: 'applying', spinner: 0, to };
  draw();
  const tick = setInterval(() => {
    if (screen.name === 'applying') {
      screen.spinner++;
      draw();
    }
  }, 120);
  try {
    await getSelfUpdater().run();
    clearInterval(tick);
    screen = { name: 'updated', from: result.currentVersion, to, sel: 0 };
    draw();
  } catch (e) {
    clearInterval(tick);
    screen = {
      name: 'message',
      title: 'Update failed',
      lines: [(e as Error).message],
      ok: false,
    };
    draw();
  }
}

// ---------------------------------------------------------------- lifecycle

let shuttingDown = false;
function shutdown(code = 0, respawnAfter = false): void {
  if (shuttingDown) return;
  shuttingDown = true;
  out(showCursor);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  void (async () => {
    try {
      if (app) await app.close();
    } catch {
      /* already closing */
    } finally {
      closeDb();
      if (respawnAfter) respawn();
      process.exit(code);
    }
  })();
}

export async function runCliTui(): Promise<void> {
  // Keep the TUI clean: suppress routine logs (fatal only). Must be set before
  // loadConfig() reads it.
  if (!process.env.LATEDEV_LOG_LEVEL) process.env.LATEDEV_LOG_LEVEL = 'fatal';

  cfg = loadConfig();

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // No interactive terminal — fall back to the plain server.
    const { startApp } = await import('../../app');
    await startApp();
    return;
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out(hideCursor);

  try {
    app = await buildApp(); // opens the DB + runs migrations
    await app.ready();
    await app.listen({ host: cfg.host, port: cfg.port });
  } catch (e) {
    out(showCursor);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stderr.write(`Fatal: ${(e as Error).message}\n`);
    closeDb();
    process.exit(1);
  }

  startedAt = Date.now();
  screen = { name: 'menu' };
  draw();
  // Live uptime + spinner redraw.
  setInterval(() => {
    if (screen.name === 'menu' || screen.name === 'check' || screen.name === 'applying') draw();
  }, 1000).unref();

  for (;;) {
    const key = await readKey();

    if (key === KEY.ctrlC || key === KEY.esc) {
      shutdown(0);
      return;
    }

    // Key handling per screen. Snapshot the discriminant once — assignments
    // to `screen` inside branches would otherwise re-narrow it mid-chain.
    const screenName: Screen['name'] = screen.name;
    if (screenName === 'menu') {
      if (key === KEY.enter || key === KEY.newline || key === KEY.space) {
        if (menuSel === 0) await openDashboard();
        else if (menuSel === 1) await runUpdateCheck();
        else {
          shutdown(0);
          return;
        }
      } else if (key === KEY.up || key === 'k') {
        menuSel = (menuSel + 2) % 3;
      } else if (key === KEY.down || key === 'j') {
        menuSel = (menuSel + 1) % 3;
      } else if (key === 'q') {
        shutdown(0);
        return;
      }
    } else if (screenName === 'checkResult') {
      const cur = screen as Extract<Screen, { name: 'checkResult' }>;
      const hasChoice = cur.result.hasUpdate && cur.result.latestVersion !== null;
      const count = hasChoice ? 2 : 1;
      if (key === KEY.up || key === 'k') {
        screen = { ...cur, sel: (cur.sel + count - 1) % count };
      } else if (key === KEY.down || key === 'j') {
        screen = { ...cur, sel: (cur.sel + 1) % count };
      } else if (key === KEY.enter || key === KEY.newline || key === KEY.space) {
        if (hasChoice && cur.sel === 0) await applyUpdate(cur.result);
        else screen = { name: 'menu' };
      } else if (key === 'q' || key === 'b') {
        screen = { name: 'menu' };
      }
    } else if (screenName === 'updated') {
      const cur = screen as Extract<Screen, { name: 'updated' }>;
      if (key === KEY.up || key === KEY.down || key === 'k' || key === 'j') {
        screen = { ...cur, sel: (cur.sel + 1) % 2 };
      } else if (key === KEY.enter || key === KEY.newline || key === KEY.space) {
        if (cur.sel === 0) {
          shutdown(0, true);
          return;
        }
        shutdown(0);
        return;
      } else if (key === 'q') {
        shutdown(0);
        return;
      }
    } else if (screenName === 'message') {
      if (key === KEY.enter || key === KEY.newline || key === KEY.space || key === 'q' || key === 'b') {
        screen = { name: 'menu' };
      }
    }
    // 'check' and 'applying' screens ignore input while busy.

    draw();
  }
}
