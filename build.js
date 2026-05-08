#!/usr/bin/env node
//
// build.js — converts initiatives/*.md into a static site.
//
// Usage:
//   node build.js
//
// Reads:   initiatives/*.md           (one file per initiative, YAML frontmatter + body)
//          templates/index.html       (landing-page layout)
//          templates/about.html       (about-page layout)
// Writes:  docs/index.html            (landing page with all initiative cards)
//          docs/about.html            (about page)
//          docs/legislation/<slug>.html    (one detail page per initiative)
// Static:  docs/assets/               (CSS + JS, edited in place)
//
// The output directory is named `docs/` so the site can be served from
// GitHub Pages (Settings → Pages → Source: main branch / docs folder).
//
// Customise the SITE constant below to change the branding shown in the
// header/footer of every page.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Site-wide configuration. Edit these values to change the chrome around the
// initiatives. Nothing else in this file needs to change to add new pages.
// ---------------------------------------------------------------------------
const SITE = {
  parent: 'European Commission',
  dgLong: 'Directorate-General for Sustainability, Ethics, Public Policy and Outrage',
  dgShort: 'DG SEPPO',
  tagline: 'Legislative initiatives portal',
  domainHint: 'ec.europa.eu',
  copyright: '© Not the European Union, 2026',
  reuseNotice: 'Reuse of this document is authorised provided the source is acknowledged.',
  disclaimer:
    'This is a fictional work of political satire. It is not affiliated with the European Union or any of its institutions. All initiatives, document codes, and offices depicted are imaginary.',
};

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'initiatives');
const TPL_DIR = path.join(ROOT, 'templates');
// Everything served by the website lives under docs/. Source files
// (build.js, templates/, initiatives/) stay at the project root.
// The `docs/` name is required for GitHub Pages serving from a subfolder.
const DOCS_DIR = path.join(ROOT, 'docs');
const OUT_INDEX = path.join(DOCS_DIR, 'index.html');
const OUT_DIR = path.join(DOCS_DIR, 'legislation');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Replace {{name}} placeholders in a template with the matching value from
// `vars`. HTML comments are stripped first so template files can carry
// documentation (which itself may use the {{...}} syntax) without leaking
// into the rendered output. Unknown placeholders are left as-is so missing
// data is visible at preview time rather than swallowed silently.
function renderTemplate(tpl, vars) {
  tpl = tpl.replace(/<!--[\s\S]*?-->/g, '');
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  );
}

function loadTemplate(name) {
  return fs.readFileSync(path.join(TPL_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Frontmatter parser. Accepts either:
//    ---
//    key: value
//    key: "value with: colons"
//    ---
//    body...
// Quotes (single or double) are optional and stripped if matched.
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') {
    return { meta: {}, body: text };
  }
  const meta = {};
  let i = 1;
  while (i < lines.length && lines[i].trim() !== '---') {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) {
      let key = m[1];
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
    i++;
  }
  const body = lines.slice(i + 1).join('\n');
  return { meta, body };
}

// ---------------------------------------------------------------------------
// Minimal markdown converter. Supports:
//   ## heading           -> h2 / h3 / h4
//   paragraph (blank-separated lines)
//   > blockquote (recursive)
//   - list / 1. ordered list
//   ---  horizontal rule
//   **bold**, *italic*, `code`, [text](url), <https://...>
//   :::name              -> wrap content in <div class="name">…</div>;
//                           close with a line containing only ':::'.
//                           Multiple classes accepted: ':::callout warning'.
// Tables and images are not (yet) supported.
// ---------------------------------------------------------------------------

function inline(s) {
  // Escape first; then re-introduce the few entities we want as markup.
  s = escapeHtml(s);
  // Bare autolinks <https://...>
  s = s.replace(/&lt;(https?:[^&\s]+)&gt;/g, (_, u) => `<a href="${u}">${u}</a>`);
  // [text](url) — allows one level of balanced parens inside the URL so
  // that DOIs such as `10.1016/S0140-6736(13)62158-3` survive intact.
  s = s.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
  // **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // *italic*
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;

  const isLine = (re, n) => n < lines.length && re.test(lines[n]);

  while (i < lines.length) {
    const line = lines[i];

    // custom fenced block: :::name … :::
    // Tracks fence depth so blocks can nest (e.g. an outer :::science-zone
    // wrapping an inner :::callout). Opening fences must include a class
    // name; closing fences are bare ':::' on their own line.
    const fence = line.match(/^:::\s*(\S.*?)\s*$/);
    if (fence) {
      const cls = fence[1];
      i++;
      const block = [];
      let depth = 1;
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        if (/^:::\s*\S/.test(l)) {
          depth++;
          block.push(l);
        } else if (/^:::\s*$/.test(l)) {
          depth--;
          if (depth > 0) block.push(l);
        } else {
          block.push(l);
        }
        i++;
      }
      out.push(`<div class="${escapeAttr(cls)}">\n${mdToHtml(block.join('\n'))}\n</div>`);
      continue;
    }

    // horizontal rule
    if (/^-{3,}\s*$/.test(line.trim())) {
      out.push('<hr>');
      i++;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const block = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        block.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${mdToHtml(block.join('\n'))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (isLine(/^\s*[-*]\s+/, i)) {
        let item = lines[i].replace(/^\s*[-*]\s+/, '');
        i++;
        // continuation lines (indented) for the same item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          item += ' ' + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (isLine(/^\s*\d+\.\s+/, i)) {
        let item = lines[i].replace(/^\s*\d+\.\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          item += ' ' + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      out.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    // blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // paragraph: collect until blank or block-starter
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^:::/.test(lines[i]) &&
      !/^-{3,}\s*$/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// SVG components — emblem and per-topic hero illustrations.
// ---------------------------------------------------------------------------

function emblemSvg(size = 28) {
  // Twelve gold stars in a circle on a deep-blue field — a stylised reference.
  const cx = 50, cy = 50, r = 32;
  let stars = '';
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 2 * Math.PI - Math.PI / 2;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    stars += `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})"><polygon points="0,-6 1.76,-1.85 6,-1.85 2.62,1.06 3.71,5.14 0,2.74 -3.71,5.14 -2.62,1.06 -6,-1.85 -1.76,-1.85" fill="#FFCC00"/></g>`;
  }
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true"><rect width="100" height="100" fill="#003399"/>${stars}</svg>`;
}

function heroSvg(topic) {
  // Simple, monochrome hero illustration on a pale field. Subtle.
  switch ((topic || '').toLowerCase()) {
    case 'noise':
      return `<svg viewBox="0 0 600 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="600" height="160" fill="#eaeef5"/>
  <g stroke="#003399" fill="none" stroke-width="1.2">
    ${Array.from({ length: 24 }, (_, k) => {
        const x = 20 + k * 24;
        const amp = 14 + Math.sin(k * 0.6) * 22 + Math.cos(k * 1.3) * 10;
        return `<line x1="${x}" y1="${80 - amp}" x2="${x}" y2="${80 + amp}"/>`;
      }).join('\n    ')}
  </g>
</svg>`;
    case 'light':
      return `<svg viewBox="0 0 600 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="600" height="160" fill="#0a1230"/>
  ${Array.from({ length: 60 }, () => {
      const x = Math.random() * 600;
      const y = Math.random() * 160;
      const r = Math.random() * 1.4 + 0.3;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#FFCC00" opacity="${(0.4 + Math.random() * 0.6).toFixed(2)}"/>`;
    }).join('\n  ')}
  <path d="M0 130 Q 150 95 300 120 T 600 110 L 600 160 L 0 160 Z" fill="#000"/>
</svg>`;
    case 'nature':
      return `<svg viewBox="0 0 600 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="600" height="160" fill="#eef2e8"/>
  <g fill="#2f4d2a">
    ${Array.from({ length: 18 }, (_, k) => {
        const x = 20 + k * 33;
        const h = 50 + (k % 3) * 18;
        return `<polygon points="${x},${130 - h} ${x - 14},${130} ${x + 14},${130}"/><rect x="${x - 2}" y="130" width="4" height="10"/>`;
      }).join('\n    ')}
  </g>
  <line x1="0" y1="140" x2="600" y2="140" stroke="#2f4d2a" stroke-width="0.5"/>
</svg>`;
    case 'water':
      return `<svg viewBox="0 0 600 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="600" height="160" fill="#e6f0f4"/>
  <g stroke="#003399" fill="none" stroke-width="0.8">
    ${Array.from({ length: 8 }, (_, k) => `<path d="M0 ${30 + k * 16} Q 75 ${20 + k * 16} 150 ${30 + k * 16} T 300 ${30 + k * 16} T 450 ${30 + k * 16} T 600 ${30 + k * 16}"/>`).join('\n    ')}
  </g>
</svg>`;
    case 'air':
      return `<svg viewBox="0 0 600 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="600" height="160" fill="#f1eee5"/>
  <g fill="#7a6f55" opacity="0.6">
    ${Array.from({ length: 80 }, () => {
      const x = Math.random() * 600;
      const y = Math.random() * 160;
      const r = Math.random() * 2 + 0.5;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}"/>`;
    }).join('\n    ')}
  </g>
</svg>`;
    case 'sleep':
      return `<svg viewBox="0 0 600 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="600" height="160" fill="#1a1f3a"/>
  <path d="M460 60 a 40 40 0 1 0 30 56 a 30 30 0 1 1 -30 -56 z" fill="#FFCC00" opacity="0.85"/>
  ${Array.from({ length: 18 }, () => {
    const x = Math.random() * 400;
    const y = Math.random() * 130 + 10;
    const r = Math.random() * 1 + 0.4;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#FFCC00" opacity="${(0.5 + Math.random() * 0.5).toFixed(2)}"/>`;
  }).join('\n  ')}
</svg>`;
    case 'screens':
      return `<svg viewBox="0 0 600 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="600" height="160" fill="#e9eaf0"/>
  <g fill="none" stroke="#003399" stroke-width="1.2">
    ${Array.from({ length: 9 }, (_, k) => {
      const x = 30 + k * 65;
      return `<rect x="${x}" y="50" width="50" height="36" rx="3"/><line x1="${x + 12}" y1="92" x2="${x + 38}" y2="92"/>`;
    }).join('\n    ')}
  </g>
</svg>`;
    default:
      return `<svg viewBox="0 0 600 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="600" height="160" fill="#003399"/>
  <g fill="#FFCC00" opacity="0.9">
    ${Array.from({ length: 12 }, (_, k) => {
      const a = (k / 12) * 2 * Math.PI - Math.PI / 2;
      const x = 300 + 56 * Math.cos(a);
      const y = 80 + 56 * Math.sin(a);
      return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})"><polygon points="0,-6 1.76,-1.85 6,-1.85 2.62,1.06 3.71,5.14 0,2.74 -3.71,5.14 -2.62,1.06 -6,-1.85 -1.76,-1.85"/></g>`;
    }).join('\n    ')}
  </g>
</svg>`;
  }
}

// ---------------------------------------------------------------------------
// Status badge — picks a colour based on the legislative stage.
// ---------------------------------------------------------------------------

function statusClass(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('in force') || s.includes('adopted')) return 'status status--adopted';
  if (s.includes('trilogue')) return 'status status--trilogue';
  if (s.includes('council')) return 'status status--council';
  if (s.includes('proposal')) return 'status status--proposal';
  if (s.includes('consultation')) return 'status status--consultation';
  return 'status status--neutral';
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function topBanner() {
  return `<div class="eu-strip" role="banner">
  <div class="container eu-strip__inner">
    <span class="eu-strip__flag" aria-hidden="true">${emblemSvg(14)}</span>
    <span class="eu-strip__label">A (not very) official website of the European Union</span>
    <a class="eu-strip__verify" target="_blank" href="https://european-union.europa.eu/institutions-law-budget/institutions-and-bodies/search-all-eu-institutions-and-bodies_en">How do you know?</a>
  </div>
</div>`;
}

function siteHeader(currentPath) {
  const langs = ['EN', 'DE', 'FR', 'ES', 'IT', 'NL', 'SV', 'FI'];

  // currentPath is one of:
  //   '/'                          → index page
  //   '/about.html'                → about page
  //   '/legislation/<slug>.html'   → initiative detail page
  // Detail pages are nested one level deeper, so links to root pages need a
  // '../' prefix from there. The "current section" indicator follows the
  // active page.
  const isInLegislationDir = currentPath.startsWith('/legislation/');
  const isAbout = currentPath === '/about.html';
  const isLegislationSection = !isAbout; // index + detail pages
  const rel = isInLegislationDir ? '../' : '';
  const homeHref = currentPath === '/' ? '#' : `${rel}index.html`;
  const indexHref = `${rel}index.html`;
  const aboutHref = `${rel}about.html`;
  const cur = (active) => (active ? ' aria-current="page"' : '');

  return `<header class="masthead">
  <div class="container masthead__inner">
    <a class="brand" href="${homeHref}">
      <span class="brand__emblem">${emblemSvg(48)}</span>
      <span class="brand__text">
        <span class="brand__parent">${escapeHtml(SITE.parent)}</span>
        <span class="brand__dg">${escapeHtml(SITE.dgLong)}</span>
      </span>
    </a>
    <div class="masthead__lang" aria-label="Language">
      ${langs.map((l, idx) => `<a class="lang${idx === 0 ? ' lang--current' : ''}" href="#">${l}</a>`).join('')}
    </div>
  </div>
  <nav class="primary-nav" aria-label="Primary">
    <div class="container primary-nav__inner">
      <a aria-disabled="true">Home</a>
      <a aria-disabled="true">Policies</a>
      <a href="${indexHref}"${cur(isLegislationSection)}>Legislation</a>
      <a aria-disabled="true">Consultations</a>
<!--      <a aria-disabled="true">Documents</a>-->
      <a aria-disabled="true">Newsroom</a>
      <a href="${aboutHref}"${cur(isAbout)}>About</a>
      <span class="primary-nav__search" role="search">
        <input type="search" placeholder="Search legislation…" aria-label="Search">
      </span>
    </div>
  </nav>
</header>`;
}

function siteFooter() {
  return `<footer class="site-footer">
  <div class="container site-footer__top">
    <div class="site-footer__col">
      <h4>${escapeHtml(SITE.dgShort)}</h4>
      <ul>
        <li><a href="#">About this directorate</a></li>
        <li><a href="#">Commissioner</a></li>
        <li><a href="#">Strategy 2024–2029</a></li>
        <li><a href="#">Annual activity report</a></li>
      </ul>
    </div>
    <div class="site-footer__col">
      <h4>Engage</h4>
      <ul>
        <li><a href="#">Public consultations</a></li>
        <li><a href="#">Citizens' initiatives</a></li>
        <li><a href="#">Have your say</a></li>
        <li><a href="#">Subscribe</a></li>
      </ul>
    </div>
    <div class="site-footer__col">
      <h4>Resources</h4>
      <ul>
        <li><a href="#">EUR-Lex</a></li>
        <li><a href="#">Official Journal</a></li>
        <li><a href="#">Open data portal</a></li>
        <li><a href="#">Statistics</a></li>
      </ul>
    </div>
    <div class="site-footer__col">
      <h4>Contact</h4>
      <ul>
        <li><a href="#">Contact ${escapeHtml(SITE.dgShort)}</a></li>
        <li><a href="#">Find an office</a></li>
        <li><a href="#">Press service</a></li>
      </ul>
    </div>
  </div>
  <div class="container site-footer__legal">
    <p>${escapeHtml(SITE.copyright)}. ${escapeHtml(SITE.reuseNotice)}</p>
    <ul class="site-footer__links">
      <li><a href="#">Legal notice</a></li>
      <li><a href="#">Cookies</a></li>
      <li><a href="#">Privacy policy</a></li>
      <li><a href="#">Accessibility</a></li>
      <li><a href="#">Sitemap</a></li>
    </ul>
  </div>
  <div class="container site-footer__disclaimer">${escapeHtml(SITE.disclaimer)}</div>
</footer>`;
}

function pageShell({ title, currentPath, content, extraHead = '' }) {
  const isRoot = currentPath === '/';
  const cssPath = isRoot ? 'assets/styles.css' : '../assets/styles.css';
  const jsPath = isRoot ? 'assets/search.js' : '../assets/search.js';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(SITE.dgLong)}</title>
<link rel="stylesheet" href="${cssPath}">
<script src="${jsPath}" defer></script>
${extraHead}
</head>
<body>
${topBanner()}
${siteHeader(currentPath)}
<main id="main">
${content}
</main>
${siteFooter()}
</body>
</html>
`;
}

function renderCard({ meta, slug }) {
  const url = `legislation/${slug}.html`;
  return `<a class="card" href="${escapeAttr(url)}">
  <div class="card__hero">${heroSvg(meta.hero_topic)}</div>
  <div class="card__body">
    <div class="card__meta">
      <span class="card__code">${escapeHtml(meta.code || '')}</span>
      <span class="${statusClass(meta.status)}">${escapeHtml(meta.status || '')}</span>
    </div>
    <h2 class="card__title">${escapeHtml(meta.short || meta.title || slug)}</h2>
    <p class="card__summary">${escapeHtml(meta.summary || '')}</p>
    <dl class="card__facts">
      <div><dt>Procedure</dt><dd>${escapeHtml(meta.procedure || '')}</dd></div>
      <div><dt>Funding</dt><dd>${escapeHtml(meta.funding || '')}</dd></div>
      <div><dt>Lead</dt><dd>${escapeHtml(meta.lead || '')}</dd></div>
    </dl>
    <span class="card__cta">Read the dossier <span aria-hidden="true">→</span></span>
  </div>
</a>`;
}

function renderEmptyState() {
  return `<div class="empty">
  <h2>No initiatives published</h2>
  <p>Add a markdown file under <code>initiatives/</code> using the structure in <code>initiatives/TEMPLATE.md</code>, then run <code>node build.js</code>.</p>
</div>`;
}

function indexPage(initiatives) {
  const tpl = loadTemplate('index.html');
  const cards = initiatives.length
    ? initiatives.map(renderCard).join('\n')
    : renderEmptyState();

  return renderTemplate(tpl, {
    site_parent: escapeHtml(SITE.parent),
    site_dg_long: escapeHtml(SITE.dgLong),
    site_dg_short: escapeHtml(SITE.dgShort),
    site_disclaimer: escapeHtml(SITE.disclaimer),
    top_banner: topBanner(),
    site_header: siteHeader('/'),
    site_footer: siteFooter(),
    count: initiatives.length,
    count_label: initiatives.length === 1 ? 'dossier' : 'dossiers',
    cards,
  });
}

function aboutPage() {
  const tpl = loadTemplate('about.html');
  return renderTemplate(tpl, {
    site_parent: escapeHtml(SITE.parent),
    site_dg_long: escapeHtml(SITE.dgLong),
    site_dg_short: escapeHtml(SITE.dgShort),
    site_disclaimer: escapeHtml(SITE.disclaimer),
    top_banner: topBanner(),
    site_header: siteHeader('/about.html'),
    site_footer: siteFooter(),
  });
}

function initiativePage({ meta, body, slug }) {
  const bodyHtml = mdToHtml(body);
  // Document reference and status appear prominently in the side panel's lead
  // block; the facts list below holds the remaining metadata.
  const facts = [
    ['Interinstitutional file', meta.procedure],
    ['Procedure', meta.procedure_label],
    ['Lead service', meta.lead],
    ['Date of latest action', meta.date],
    ['Financial envelope', meta.funding],
    ['Funding source', meta.funding_source],
  ];
  const factsHtml = facts
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('\n');

  const breadcrumbLast = meta.short || meta.code || slug;

  const content = `
<section class="document">
  <div class="container document__inner">
    <p class="breadcrumb"><a href="../index.html">Home</a> <span>›</span> <a href="../index.html">Legislation</a> <span>›</span> ${escapeHtml(breadcrumbLast)}</p>

    <div class="document__hero">${heroSvg(meta.hero_topic)}</div>

    <header class="document__head">
      <h1>${escapeHtml(meta.title || meta.short || slug)}</h1>
      ${meta.short ? `<p class="document__short"><em>Short title:</em> ${escapeHtml(meta.short)}</p>` : ''}
    </header>

    <div class="document__layout">
      <article class="document__body">
        ${bodyHtml}
      </article>

      <aside class="document__aside" aria-label="Document metadata">
        <div class="aside-lead">
          ${meta.status ? `<span class="${statusClass(meta.status)}">${escapeHtml(meta.status)}</span>` : ''}
          ${meta.code ? `<p class="aside-lead__code">${escapeHtml(meta.code)}</p>` : ''}
        </div>
        <dl class="facts">
          ${factsHtml}
        </dl>
        <div class="aside-block">
          <h3>Downloads</h3>
          <ul class="downloads">
            <li><a href="#">Full text (PDF)</a></li>
            <li><a href="#">Annexes (PDF)</a></li>
            <li><a href="#">Impact assessment (PDF)</a></li>
            <li><a href="#">Citizens' summary (PDF)</a></li>
          </ul>
        </div>
        <div class="aside-block">
          <h3>Available languages</h3>
          <p class="aside-block__langs">BG · CS · DA · DE · EL · <strong>EN</strong> · ES · ET · FI · FR · GA · HR · HU · IT · LT · LV · MT · NL · PL · PT · RO · SK · SL · SV</p>
        </div>
      </aside>
    </div>
  </div>
</section>`;

  return pageShell({
    title: meta.short || meta.title || slug,
    currentPath: `/legislation/${slug}.html`,
    content,
  });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function loadInitiatives() {
  if (!fs.existsSync(SRC_DIR)) return [];
  const files = fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !f.startsWith('_') && f !== 'TEMPLATE.md');

  return files
    .map((file) => {
      const full = path.join(SRC_DIR, file);
      const raw = fs.readFileSync(full, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const slug = (meta.slug || file.replace(/\.md$/, '')).trim();
      return { file, meta, body, slug };
    })
    .sort((a, b) => {
      // Sort by date desc, falling back to filename.
      const da = Date.parse(a.meta.date) || 0;
      const db = Date.parse(b.meta.date) || 0;
      if (da !== db) return db - da;
      return a.slug.localeCompare(b.slug);
    });
}

function build() {
  const initiatives = loadInitiatives();

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Write index.
  fs.writeFileSync(OUT_INDEX, indexPage(initiatives));

  // Write the About page.
  fs.writeFileSync(path.join(DOCS_DIR, 'about.html'), aboutPage());

  // Write each initiative.
  for (const init of initiatives) {
    const outPath = path.join(OUT_DIR, `${init.slug}.html`);
    fs.writeFileSync(outPath, initiativePage(init));
  }

  // Tidy any stale output files no longer matching a source.
  const validFiles = new Set(initiatives.map((i) => `${i.slug}.html`));
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.html') && !validFiles.has(f)) {
      fs.unlinkSync(path.join(OUT_DIR, f));
    }
  }

  console.log(`Built ${initiatives.length} initiative${initiatives.length === 1 ? '' : 's'}.`);
  if (initiatives.length === 0) {
    console.log('Hint: copy initiatives/TEMPLATE.md to initiatives/<your-slug>.md and rebuild.');
  } else {
    for (const i of initiatives) console.log(`  · ${i.slug}  (${i.meta.code || 'no code'})`);
  }
  console.log(`\nOpen docs/index.html in a browser to preview.`);
}

build();
