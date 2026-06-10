/* fill.js — runs in the browser BEFORE deck-stage.js.
   Reads window.__BRIEF__ and binds it into the static template:
     - [data-field="a.b.c"]      -> element.textContent  (dotted path into the brief)
     - [data-field-html="a.b"]   -> element.innerHTML
     - [data-repeat="path"]      -> clone the container's first child once per array item;
                                    inside each clone, data-field resolves RELATIVE to the item
                                    (use data-field="." for an array of plain strings).
     - [data-repeat-cols]        -> set grid-template-columns to repeat(N,1fr) for the item count.
   If a field / repeat array is absent in the brief, the template's authored default is left intact.
   Finally: switches the deck into export mode (strips .fld markers) and locks the moodboard look. */
(function () {
  var B = window.__BRIEF__;
  if (!B) return;

  function get(obj, path) {
    if (path === '.') return obj;
    return String(path).split('.').reduce(function (o, k) {
      return (o == null) ? undefined : o[k];
    }, obj);
  }

  // data-field-html is only meant for line breaks — strip every tag except <br>.
  function safeHtml(s) {
    return String(s).replace(/<(?!br\s*\/?>)[^>]*>/gi, '');
  }

  function applyFields(root, ctx) {
    var els = root.querySelectorAll('[data-field],[data-field-html]');
    Array.prototype.forEach.call(els, function (el) {
      if (el.closest('[data-repeat]') && root === document) return; // repeats handled separately
      var t = el.getAttribute('data-field');
      if (t) { var v = get(ctx, t); if (v != null) el.textContent = v; }
      var h = el.getAttribute('data-field-html');
      if (h) { var vh = get(ctx, h); if (vh != null) el.innerHTML = safeHtml(vh); }
    });
  }

  // 1) Repeats first.
  Array.prototype.forEach.call(document.querySelectorAll('[data-repeat]'), function (container) {
    var arr = get(B, container.getAttribute('data-repeat'));
    if (!Array.isArray(arr) || !arr.length) return; // keep authored default
    var tpl = container.firstElementChild;
    if (!tpl) return;
    var tplHTML = tpl.outerHTML;
    container.innerHTML = '';
    arr.forEach(function (item) {
      var wrap = document.createElement('div');
      wrap.innerHTML = tplHTML;
      var node = wrap.firstElementChild;
      // fill the clone's fields relative to the item
      var inner = node.querySelectorAll('[data-field],[data-field-html]');
      Array.prototype.forEach.call(inner, function (el) {
        // Clear unprovided fields so a missing brief value can't leak the template's default text.
        var t = el.getAttribute('data-field');
        if (t) { var v = get(item, t); el.textContent = (v != null ? v : ''); }
        var h = el.getAttribute('data-field-html');
        if (h) { var vh = get(item, h); el.innerHTML = (vh != null ? safeHtml(vh) : ''); }
      });
      container.appendChild(node);
    });
    if (container.hasAttribute('data-repeat-cols')) {
      container.style.gridTemplateColumns = 'repeat(' + arr.length + ',1fr)';
    }
  });

  // 2) Top-level fields (those not inside a repeat).
  applyFields(document, B);

  // 3) Export mode + locked moodboard look.
  document.body.classList.add('export');
  var look = B.lookVariant || 'wall';
  try { localStorage.setItem('viewix-moodboard', look); } catch (e) {}
  var creative = document.querySelector('.creative');
  if (creative) {
    Array.prototype.forEach.call(creative.querySelectorAll('.md-variant'), function (v) {
      if (v.getAttribute('data-v') === look) v.setAttribute('data-active', '');
      else v.removeAttribute('data-active');
    });
    var sw = creative.querySelector('.md-switch');
    if (sw) sw.remove();
  }
})();
