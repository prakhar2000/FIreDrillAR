export function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}
