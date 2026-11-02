// Rückfragen und Meldungen im Stil von Ventoview statt confirm(), alert() und prompt() des Browsers – auf allen Seiten
// und in der App gleich (dieselbe Datei liegt auch in der App unter ui/dialog.js, das Aussehen in dialog.css).
//   if (await VVDialog.confirm('„X“ löschen?', { ok: 'Löschen', danger: true })) …   → true / false
//   await VVDialog.alert('Gespeichert.')                                            → wenn geschlossen
//   const name = await VVDialog.prompt('Name?', 'Vorgabe')                           → Text oder null
// Text: die erste Zeile bzw. alles bis zum ersten „? “ wird die Überschrift, der Rest steht darunter. Statt eines
// Textes geht auch { title, text }. Übersetzt wird wie bei confirm() Zeile für Zeile (i18n.js).
(() => {
  const t = (text) => (window.VVI18n && !document.body?.hasAttribute('data-no-i18n') ? window.VVI18n.t(text) : text);
  const translate = (text) => String(text ?? '').split('\n').map((line) => (line.trim() ? t(line) : line)).join('\n');

  function parts(message) {
    if (message && typeof message === 'object') return { title: translate(message.title), text: translate(message.text) };
    const full = translate(message);
    const line = full.indexOf('\n');
    const question = /\?\s/.exec(full);
    const cut = line >= 0 ? line : question ? question.index + 1 : -1;
    return cut > 0 ? { title: full.slice(0, cut).trim(), text: full.slice(cut).trim() } : { title: full, text: '' };
  }

  function el(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, value);
    if (text) node.textContent = text;
    return node;
  }

  // Ein Fenster: ok → okValue, Abbrechen/Esc → cancelValue
  function open(message, { ok = 'OK', cancel = null, danger = false, input = null, okValue = true, cancelValue = false }) {
    const { title, text } = parts(message);
    return new Promise((resolve) => {
      // data-no-i18n: schon übersetzt – sonst würde i18n.js die Übersetzung noch einmal anfassen
      const dialog = el('dialog', { class: 'vv-dialog', 'data-no-i18n': '', role: cancel ? 'alertdialog' : 'dialog' });
      const field = input == null ? null : el('input', { type: 'text', class: 'vv-dialog-input', spellcheck: 'false' });
      if (field) field.value = input;
      const okBtn = el('button', { type: 'button', class: danger ? 'danger' : 'primary' }, t(ok));
      const cancelBtn = cancel ? el('button', { type: 'button' }, t(cancel)) : null;
      const actions = el('div', { class: 'vv-dialog-actions' });
      if (cancelBtn) actions.append(cancelBtn);
      actions.append(okBtn);
      dialog.append(el('h2', {}, title));
      if (text) dialog.append(el('p', {}, text));
      if (field) dialog.append(field);
      dialog.append(actions);

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        dialog.close();
        dialog.remove();
        resolve(value);
      };
      okBtn.addEventListener('click', () => finish(field ? field.value : okValue));
      cancelBtn?.addEventListener('click', () => finish(cancelValue));
      // Esc: wie Abbrechen (ohne Abbrechen-Knopf wie OK)
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        finish(cancelBtn ? cancelValue : okValue);
      });
      field?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(field.value);
        }
      });
      // Tasten bleiben im Fenster – sonst würde z. B. Entf im Editor dahinter Ebenen löschen
      dialog.addEventListener('keydown', (e) => e.stopPropagation());
      document.body.append(dialog);
      dialog.showModal();
      // Bei gefährlichen Fragen landet Enter auf „Abbrechen“, sonst auf dem Hauptknopf
      if (field) {
        field.focus();
        field.select();
      } else {
        (danger && cancelBtn ? cancelBtn : okBtn).focus();
      }
    });
  }

  window.VVDialog = {
    confirm: (message, opts = {}) => open(message, { ok: opts.ok || 'OK', cancel: opts.cancel || 'Abbrechen', danger: opts.danger }),
    alert: (message, opts = {}) => open(message, { ok: opts.ok || 'OK', okValue: undefined, cancelValue: undefined }),
    prompt: (message, value = '', opts = {}) => open(message, { ok: opts.ok || 'OK', cancel: opts.cancel || 'Abbrechen', input: String(value ?? ''), cancelValue: null }),
  };
})();
