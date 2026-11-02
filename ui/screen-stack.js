// Ein Overlay-Rahmen je Design (?u=…), in der Reihenfolge von unten nach oben – das letzte verdeckt die anderen
for (const src of new URLSearchParams(location.search).getAll('u')) {
  if (!/^https?:\/\//.test(src)) continue;
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.allow = 'autoplay';
  document.body.append(frame);
}
