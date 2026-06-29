/* fill.js — binds window.__DATA__ into the static report template.
   Recursive, scope-correct:
     - [data-repeat="path"] -> clone the container's first child once per array item;
       each clone is filled RELATIVE to its item (supports nesting).
     - [data-field="a.b.c"] -> element.textContent (dotted path; "." = the item itself)
     - [data-status="path"] -> sets data-state="<value lowercased>" for pill colouring
   Missing values render empty so the template's sample text can never leak. */
(function () {
  var D = window.__DATA__;
  if (!D) return;

  function get(obj, path) {
    if (path === '.') return obj;
    return String(path).split('.').reduce(function (o, k) {
      return (o == null) ? undefined : o[k];
    }, obj);
  }

  // Is `el` nested under a [data-repeat] that lives strictly between it and `root`?
  // Such elements are bound during that repeat's own recursion, not here.
  function underInnerRepeat(el, root) {
    var p = el.parentElement;
    while (p && p !== root) {
      if (p.hasAttribute && p.hasAttribute('data-repeat')) return true;
      p = p.parentElement;
    }
    return false;
  }

  function fill(root, ctx) {
    // 1) Expand the top-most repeats within this scope.
    var repeats = [];
    Array.prototype.forEach.call(root.querySelectorAll('[data-repeat]'), function (c) {
      if (!underInnerRepeat(c, root)) repeats.push(c);
    });
    repeats.forEach(function (container) {
      var arr = get(ctx, container.getAttribute('data-repeat'));
      var tpl = container.firstElementChild;
      if (!tpl) return;
      // cloneNode (not innerHTML) so table rows keep their <table> parse context.
      var master = tpl.cloneNode(true);
      container.innerHTML = '';
      if (!Array.isArray(arr)) return;
      arr.forEach(function (item) {
        var node = master.cloneNode(true);
        fill(node, item); // recurse: nested repeats + fields, relative to the item
        container.appendChild(node);
      });
    });

    // 2) Plain fields directly in this scope (not inside an inner repeat).
    Array.prototype.forEach.call(root.querySelectorAll('[data-field]'), function (el) {
      if (underInnerRepeat(el, root)) return;
      var v = get(ctx, el.getAttribute('data-field'));
      el.textContent = (v != null ? v : '');
    });

    // 3) Status pills in this scope.
    Array.prototype.forEach.call(root.querySelectorAll('[data-status]'), function (el) {
      if (underInnerRepeat(el, root)) return;
      var s = get(ctx, el.getAttribute('data-status'));
      if (s) el.setAttribute('data-state', String(s).toLowerCase());
    });
  }

  fill(document.body, D);
  document.body.classList.add('ready');
})();
