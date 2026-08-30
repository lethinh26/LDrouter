/**
 * Minimal ANSI escape codes — no dependencies.
 */

export const home = '\x1b[H'; // Move cursor to top-left (0,0)
export const clear = '\x1b[2J'; // Clear screen and move cursor to home
export const eraseDown = '\x1b[0J'; // Clear from cursor to end of screen
export const hideCursor = '\x1b[?25l';
export const showCursor = '\x1b[?25h';

export const color = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
};

export function line(char: string = '─'): string {
  return char.repeat(40);
}

export function spinnerFrame(tick: number): string {
  const frames = ['◐', '◓', '◑', '◒'];
  return frames[Math.floor(tick / 2) % frames.length] as string;
}

export function statusDot(on: boolean): string {
  return on ? '●' : '○';
}

export function check(ok: boolean): string {
  return ok ? '✓' : '✗';
}

export function arrow(direction: 'up' | 'down' | 'enter'): string {
  switch (direction) {
    case 'up':
      return '↑';
    case 'down':
      return '↓';
    case 'enter':
      return '→';
  }
}

export function getTerminalWidth(): number {
  if (typeof process.stdout !== 'undefined' && process.stdout.columns) {
    return Math.min(process.stdout.columns, 80);
  }
  return 80;
}

export function getTerminalHeight(): number {
  if (typeof process.stdout !== 'undefined' && process.stdout.rows) {
    return Math.max(process.stdout.rows, 24);
  }
  return 24;
}

// Screen helpers
export function clearAndHome(): void {
  process.stdout.write(clear + home);
}
