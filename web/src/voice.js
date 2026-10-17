export function parseCommand(text = '') {
  const words = String(text).toLowerCase();

  // Check blocked before exit so “block this exit” works.
  if (/\b(block|blocked)\b/.test(words)) {
    return { type: 'block' };
  }

  if (/\breset\b/.test(words)) return { type: 'reset' };
  if (/\bclear\b/.test(words)) return { type: 'clear' };
  if (/\bstop\b/.test(words)) return { type: 'stop' };
  if (/\bstart\b/.test(words)) return { type: 'start' };

  if (/\bfire\b/.test(words)) {
    return {
      type: 'fire',
      on: /\btable\b/.test(words) ? 'table' : null,
    };
  }

  if (/\bexit\b/.test(words)) return { type: 'exit' };

  return null;
}

export function start() {}
