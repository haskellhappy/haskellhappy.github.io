/**
 * Multitenant client-side engine.
 * Tenant registry is built at boot from tenants/manifest.json +
 * each tenant's config.json — no domain hardcoding here.
 * To add a tenant: create its folder + config.json, add its id to manifest.json.
 */

// ─── Entry ────────────────────────────────────────────────────────────────────

async function boot() {
  // 1. Load manifest → fetch all configs in parallel → build domain map
  let domainMap;
  try {
    domainMap = await buildDomainMap();
  } catch (e) {
    showError(`Failed to load tenant manifest: ${e.message}`);
    return;
  }

  // 2. Resolve current tenant
  const param    = new URLSearchParams(location.search).get('tenant');
  const tenantId = param || domainMap[location.hostname] || null;

  if (!tenantId) {
    const ids = [...new Set(Object.values(domainMap))].join(', ');
    showError(
      `No tenant matched for host <strong>${location.hostname}</strong>.<br>
       Use <code>?tenant=&lt;id&gt;</code> to preview locally. Known ids: <em>${ids}</em>`
    );
    return;
  }

  // 3. Config is already in memory from step 1 (or fetch fresh for ?tenant= param)
  let config = domainMap.__configs?.[tenantId];
  if (!config) {
    try {
      const res = await fetch(`/tenants/${tenantId}/config.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      config = await res.json();
    } catch (e) {
      showError(`Failed to load config for tenant <strong>${tenantId}</strong>: ${e.message}`);
      return;
    }
  }

  applyMeta(config.meta || {});
  applyTheme(config.theme || {});

  await loadStylesheets(config.stylesheets || []);
  await renderSections(tenantId, config);

  hideLoader();

  await loadScripts(config.scripts || []);
}

// ─── Tenant registry ──────────────────────────────────────────────────────────

async function buildDomainMap() {
  const res = await fetch('/tenants/manifest.json');
  if (!res.ok) throw new Error(`manifest.json returned HTTP ${res.status}`);
  const ids = await res.json();

  // Fetch all configs in parallel
  const configs = await Promise.all(
    ids.map(id =>
      fetch(`/tenants/${id}/config.json`)
        .then(r => r.ok ? r.json() : Promise.reject(`config for "${id}" returned ${r.status}`))
        .catch(err => { console.warn(err); return null; })
    )
  );

  // Build hostname → tenantId map from each config's "domains" array
  const map = { __configs: {} };
  ids.forEach((id, i) => {
    const cfg = configs[i];
    if (!cfg) return;
    map.__configs[id] = cfg;
    (cfg.domains || []).forEach(domain => { map[domain] = id; });
  });

  return map;
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

function applyMeta({ title, description, lang } = {}) {
  if (title) document.title = title;
  if (lang) document.documentElement.lang = lang;
  if (description) {
    let tag = document.querySelector('meta[name="description"]');
    if (!tag) {
      tag = document.createElement('meta');
      tag.name = 'description';
      document.head.appendChild(tag);
    }
    tag.content = description;
  }
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(`--${key}`, value);
  }
}

// ─── Stylesheets ──────────────────────────────────────────────────────────────

function loadStylesheets(urls) {
  return Promise.all(urls.map(url => new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${url}"]`)) { resolve(); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.onload = resolve;
    link.onerror = () => { console.warn(`Stylesheet failed: ${url}`); resolve(); };
    document.head.appendChild(link);
  })));
}

// ─── Scripts (sequential — jQuery must load before plugins) ──────────────────

function loadScripts(urls) {
  return urls.reduce((chain, url) => chain.then(() => new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => { console.warn(`Script failed: ${url}`); resolve(); };
    document.body.appendChild(script);
  })), Promise.resolve());
}

// ─── Section rendering ────────────────────────────────────────────────────────

async function renderSections(tenantId, config) {
  const app = document.getElementById('app');
  const sections = config.sections || [];

  const fetches = sections.map(name =>
    fetch(`/tenants/${tenantId}/sections/${name}.html`)
      .then(r => r.ok ? r.text() : Promise.reject(`Section "${name}" returned ${r.status}`))
      .catch(err => { console.warn(err); return ''; })
  );

  const htmls = await Promise.all(fetches);

  for (const html of htmls) {
    if (!html) continue;
    const rendered = interpolate(html, config);
    const tmp = document.createElement('div');
    tmp.innerHTML = rendered;
    while (tmp.firstChild) app.appendChild(tmp.firstChild);
  }
}

// ─── Template interpolation ───────────────────────────────────────────────────

function interpolate(template, data) {
  // Handle {{#each path.to.array}} ... {{/each}} blocks first
  template = template.replace(
    /\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_, path, block) => {
      const arr = resolvePath(data, path);
      if (!Array.isArray(arr)) return '';
      return arr.map(item => {
        // Within the block, resolve {{fieldName}} against the item, with data as fallback
        return block.replace(/\{\{([\w.]+)\}\}/g, (m, key) => {
          const fromItem = resolvePath(item, key);
          if (fromItem !== undefined && fromItem !== null) return fromItem;
          const fromData = resolvePath(data, key);
          return fromData !== undefined && fromData !== null ? fromData : m;
        });
      }).join('');
    }
  );

  // Then handle scalar {{dot.path}} tokens
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, path) => {
    const val = resolvePath(data, path);
    return val !== undefined && val !== null ? val : match;
  });
}

function resolvePath(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, obj);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function hideLoader() {
  const loader = document.getElementById('loader');
  const app = document.getElementById('app');
  if (loader) {
    loader.classList.add('hidden');
    setTimeout(() => loader.remove(), 400);
  }
  if (app) app.hidden = false;
}

function showError(msg) {
  const loader = document.getElementById('loader');
  if (!loader) return;
  loader.classList.add('error');
  loader.querySelector('p').innerHTML = msg;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

boot();
