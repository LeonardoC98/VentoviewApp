// Ein Overlay-Rahmen je Design (?u=…), in der Reihenfolge von unten nach oben – das letzte verdeckt die anderen.
// ?preview=1: Vorschau im Vollbild – Schachbrett hinter durchsichtigen Stellen, X oben rechts oder Esc schließt
const params = new URLSearchParams(location.search);
for (const src of params.getAll('u')) {
  if (!/^https?:\/\//.test(src)) continue;
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.allow = 'autoplay';
  document.body.append(frame);
}
if (params.get('preview') === '1') {
  document.body.classList.add('preview');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.title = 'Vorschau schließen (Esc)';
  close.setAttribute('aria-label', 'Vorschau schließen');
  close.addEventListener('click', () => window.close());
  document.body.append(close);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
}
