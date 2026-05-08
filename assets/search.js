// Live-filters the initiative cards on the landing page using whatever the
// user types into the primary-nav search input. Matches against the full
// visible text content of each card (title, code, summary, facts).
//
// Self-contained, no dependencies. Loads everywhere; no-op on pages that
// don't have a card grid.
(function () {
  'use strict';

  var input = document.querySelector('.primary-nav__search input[type="search"]');
  var grid = document.querySelector('.grid');
  if (!input || !grid) return;

  var cards = Array.prototype.slice.call(grid.querySelectorAll('.card'));
  if (!cards.length) return;

  // Cache normalised text once so each keystroke is cheap.
  var indexed = cards.map(function (card) {
    return {
      el: card,
      text: (card.textContent || '').toLowerCase().replace(/\s+/g, ' '),
    };
  });

  var headEl = document.querySelector('.initiatives__head h2');
  var origHeadText = headEl ? headEl.textContent : '';
  var emptyMsg = null;

  function ensureEmptyMsg() {
    if (emptyMsg) return emptyMsg;
    emptyMsg = document.createElement('div');
    emptyMsg.className = 'empty search-empty';
    emptyMsg.innerHTML =
      '<h2>No matches</h2><p>No initiative matches “<strong></strong>”.</p>';
    grid.appendChild(emptyMsg);
    return emptyMsg;
  }

  function applyFilter(rawQuery) {
    var query = (rawQuery || '').trim().toLowerCase();
    var visible = 0;

    indexed.forEach(function (item) {
      var match = !query || item.text.indexOf(query) !== -1;
      item.el.style.display = match ? '' : 'none';
      if (match) visible++;
    });

    if (headEl) {
      if (query) {
        headEl.textContent =
          visible + ' ' + (visible === 1 ? 'match' : 'matches');
      } else {
        headEl.textContent = origHeadText;
      }
    }

    if (visible === 0 && query) {
      var msg = ensureEmptyMsg();
      msg.querySelector('strong').textContent = rawQuery.trim();
      msg.style.display = '';
    } else if (emptyMsg) {
      emptyMsg.style.display = 'none';
    }
  }

  input.addEventListener('input', function (e) {
    applyFilter(e.target.value);
  });

  // Live-filtering means the implicit Enter-to-submit isn't useful — swallow
  // it so the page doesn't try to navigate.
  var form = input.closest('form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
    });
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') e.preventDefault();
    if (e.key === 'Escape') {
      input.value = '';
      applyFilter('');
    }
  });

  // Restore filter from URL hash if present (e.g. #q=noise)
  var match = (location.hash || '').match(/[#&]q=([^&]+)/);
  if (match) {
    var q = decodeURIComponent(match[1]);
    input.value = q;
    applyFilter(q);
  }
})();
