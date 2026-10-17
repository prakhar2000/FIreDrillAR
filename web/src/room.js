export function start() {}

export function update() {}

export async function loadRoom() {
  const res = await fetch('/api/room');
  if (!res.ok) return null;
  return res.json();
}
