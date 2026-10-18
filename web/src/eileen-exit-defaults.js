const PREFIX = 'eileen:default-exits:v1:';

export function exitDefaults(snapshot, roomId) {
  if (snapshot?.version !== 1 || snapshot.roomId !== roomId
    || !Array.isArray(snapshot.items) || snapshot.items.length > 500) {
    throw new Error('Choose an annotation export for this room.');
  }
  const exits = snapshot.items.filter((item) => item?.type === 'exit');
  if (!exits.every((item) => Array.isArray(item.position) && item.position.length === 3
    && item.position.every(Number.isFinite))) throw new Error('Exit coordinates are invalid.');
  return exits.map((item) => ({ type: 'exit', position: [...item.position], source: 'manual' }));
}

export function readDefaultExits(storage, roomId) {
  const json = storage.getItem(PREFIX + roomId);
  return json === null ? [] : exitDefaults(JSON.parse(json), roomId);
}

export function saveDefaultExits(storage, roomId, items) {
  const snapshot = { version: 1, roomId, items };
  storage.setItem(PREFIX + roomId, JSON.stringify({ ...snapshot, items: exitDefaults(snapshot, roomId) }));
}
