/* stock-chker - all client logic.
 * No build step, no framework, no dependencies.
 * Persists to localStorage so reloads don't lose your list.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "stockchker:v1";
  const URL_REGEX = /https?:\/\/[^\s<>"'`\\]+/gi;

  /** @type {{links: Array<{url:string,status:string,message:string,statusCode:number,finalUrl:string,addedAt:number,checkedAt:number}>, filter:string, codeblockFilter:string, intervalSec:number, autoOn:boolean}} */
  const state = {
    links: [],
    filter: "all",
    codeblockFilter: "live",
    intervalSec: 120,
    autoOn: false,
  };

  let autoTimer = null;
  let inFlight = 0;
  // staticMode = true when /api/health is unreachable (e.g. GitHub Pages).
  // In that mode we disable auto-check and show manual Open / Mark live / Mark dead buttons.
  let staticMode = false;
  let modeKnown = false;

  // --------- persistence ---------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.links)) {
        state.links = parsed.links.map(normalizeLink);
        // Re-apply the trim-to-last-"=" rule to anything that was saved before
        // we shipped that rule, and merge any duplicates that creates. This
        // makes the dedupe consistent: pasting "the same" link a second time
        // recognizes it as a duplicate even if your old entry was un-trimmed.
        migrateLinks();
      }
      if (typeof parsed.intervalSec === "number") state.intervalSec = parsed.intervalSec;
      if (typeof parsed.filter === "string") state.filter = parsed.filter;
      if (typeof parsed.codeblockFilter === "string") state.codeblockFilter = parsed.codeblockFilter;
    } catch (e) {
      console.warn("Failed to load state", e);
    }
  }
  function migrateLinks() {
    const seen = new Map();
    let changed = false;
    for (const l of state.links) {
      const cleaned = cleanUrl(l.url);
      if (cleaned !== l.url) changed = true;
      l.url = cleaned;
      const prev = seen.get(cleaned);
      if (!prev) {
        seen.set(cleaned, l);
        continue;
      }
      changed = true;
      // Keep the entry with the most recent check (or the first one if neither was checked).
      if ((l.checkedAt || 0) > (prev.checkedAt || 0)) {
        seen.set(cleaned, l);
      }
    }
    if (changed) {
      state.links = Array.from(seen.values()).filter((l) => l.url);
      save();
    }
  }
  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          links: state.links,
          intervalSec: state.intervalSec,
          filter: state.filter,
          codeblockFilter: state.codeblockFilter,
        }),
      );
    } catch (e) {
      console.warn("Failed to save state", e);
    }
  }
  function normalizeLink(l) {
    return {
      url: String(l.url || ""),
      status: l.status || "pending",
      message: l.message || "",
      statusCode: typeof l.statusCode === "number" ? l.statusCode : 0,
      finalUrl: l.finalUrl || "",
      addedAt: typeof l.addedAt === "number" ? l.addedAt : Date.now(),
      checkedAt: typeof l.checkedAt === "number" ? l.checkedAt : 0,
    };
  }

  // --------- parsing & dedupe ---------
  // Trim a single URL-ish run to the canonical link the user actually wants.
  //
  // Rules (in order):
  //   1. Strip trailing punctuation that's clearly not part of a URL.
  //   2. If the URL contains "=", truncate to the LAST "=" (inclusive). This
  //      matches Google One / activation tokens which all end in "=" padding.
  //      Anything pasted after the final "=" (junk text, another link with no
  //      whitespace separator, etc.) is dropped.
  function cleanUrl(raw) {
    if (!raw) return "";
    raw = raw.replace(/[)\],.;!?>]+$/g, "");
    if (!raw) return "";
    const lastEq = raw.lastIndexOf("=");
    if (lastEq !== -1) {
      raw = raw.slice(0, lastEq + 1);
    }
    return raw;
  }

  function extractUrls(text) {
    if (!text) return [];
    const out = [];
    const seen = new Set();
    const matches = text.match(URL_REGEX) || [];
    for (const raw of matches) {
      // A single regex match may contain multiple concatenated URLs if the
      // user's paste glued them together with no whitespace. Split on every
      // internal "http(s)://" so each becomes its own candidate.
      const parts = raw.split(/(?=https?:\/\/)/i);
      for (const part of parts) {
        const cleaned = cleanUrl(part);
        if (!cleaned) continue;
        if (!/^https?:\/\//i.test(cleaned)) continue;
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        out.push(cleaned);
      }
    }
    return out;
  }

  function addLinks(urls) {
    const existing = new Set(state.links.map((l) => l.url));
    let added = 0;
    let dupes = 0;
    for (const u of urls) {
      if (existing.has(u)) {
        dupes += 1;
        continue;
      }
      existing.add(u);
      state.links.push(
        normalizeLink({
          url: u,
          status: "pending",
          addedAt: Date.now(),
        }),
      );
      added += 1;
    }
    save();
    render();
    return { added, dupes };
  }

  // --------- checking ---------
  async function checkOne(idx) {
    if (staticMode) return; // no API in static mode
    const link = state.links[idx];
    if (!link) return;
    link.status = "checking";
    link.message = "";
    inFlight += 1;
    renderRow(idx);
    updateAutoStatus();
    try {
      const r = await fetch("api/check?url=" + encodeURIComponent(link.url));
      const data = await r.json();
      link.status = data.status || "unknown";
      link.message = data.message || "";
      link.finalUrl = data.final_url || "";
      link.statusCode = data.status_code || 0;
      link.checkedAt = Date.now();
    } catch (e) {
      link.status = "unknown";
      link.message = "Local proxy unreachable - is server.py running?";
      link.checkedAt = Date.now();
    } finally {
      inFlight = Math.max(0, inFlight - 1);
      save();
      renderRow(idx);
      renderStats();
      updateAutoStatus();
    }
  }

  function markStatus(idx, status) {
    const link = state.links[idx];
    if (!link) return;
    link.status = status;
    link.message = status === "live" ? "Marked live (manual)" :
                   status === "dead" ? "Marked dead (manual)" :
                   "";
    link.checkedAt = Date.now();
    save();
    renderRow(idx);
    renderStats();
  }

  async function checkAll(concurrency = 4) {
    const indices = state.links.map((_, i) => i);
    const queue = indices.slice();
    const workers = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(
        (async function worker() {
          while (queue.length) {
            const i = queue.shift();
            await checkOne(i);
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  function startAuto() {
    if (staticMode) {
      flash("Auto-check needs the local server. You're on GitHub Pages — use Open + Mark live/dead.");
      return;
    }
    if (autoTimer) return;
    state.autoOn = true;
    save();
    const tick = async () => {
      if (!state.autoOn) return;
      try {
        await checkAll(4);
      } catch (e) {
        console.warn(e);
      }
    };
    tick();
    autoTimer = setInterval(tick, Math.max(10, state.intervalSec) * 1000);
    updateAutoStatus();
  }
  function stopAuto() {
    state.autoOn = false;
    save();
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    updateAutoStatus();
  }

  // --------- export / actions ---------
  function downloadTxt(filename, links) {
    if (!links.length) {
      alert("Nothing to download.");
      return;
    }
    // Each link separated by 2 blank lines (so 3 newlines between URLs)
    const body = links.map((l) => l.url).join("\n\n\n") + "\n";
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  // Copy text to clipboard. Tries the modern async API first, falls back to
  // a hidden textarea + execCommand("copy") for older browsers / iOS Safari
  // when the page is served over plain http (where navigator.clipboard is
  // unavailable).
  async function copyTextToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      // fall through to legacy path
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function copyLinksToClipboard(links, label) {
    if (!links.length) {
      flash(`No ${label} links to copy.`);
      return;
    }
    // Each link on its own line + 2 blank lines between, matching the .txt export.
    const body = links.map((l) => l.url).join("\n\n\n");
    const ok = await copyTextToClipboard(body);
    if (ok) {
      flash(`Copied ${links.length} ${label} link(s) to clipboard.`);
    } else {
      flash(`Couldn't copy ${label} links — long-press the box and copy manually.`);
    }
  }

  // --------- rendering ---------
  const $ = (id) => document.getElementById(id);

  function statusBadge(s) {
    const map = { live: "live", dead: "dead", unknown: "unknown", checking: "checking", pending: "pending" };
    const cls = map[s] || "pending";
    return `<span class="badge ${cls}">${s}</span>`;
  }

  function fmtTime(ts) {
    if (!ts) return "never";
    const d = new Date(ts);
    return d.toLocaleString();
  }

  function renderStats() {
    const counts = { all: state.links.length, live: 0, dead: 0, unknown: 0, pending: 0, checking: 0 };
    for (const l of state.links) counts[l.status] = (counts[l.status] || 0) + 1;
    const labels = [
      ["all", "Total"],
      ["live", "Live"],
      ["dead", "Dead"],
      ["unknown", "Unknown"],
      ["pending", "Pending"],
      ["checking", "Checking"],
    ];
    $("stats").innerHTML = labels
      .map(([k, l]) => `<div class="stat"><div class="n">${counts[k] || 0}</div><div class="l">${l}</div></div>`)
      .join("");

    const filterEl = $("filters");
    filterEl.innerHTML = labels
      .map(([k, l]) => {
        const active = state.filter === k ? "active" : "";
        return `<button class="filter ${active}" data-filter="${k}">${l} (${counts[k] || 0})</button>`;
      })
      .join("");
    filterEl.querySelectorAll(".filter").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.filter;
        save();
        renderStats();
        renderRows();
      });
    });
  }

  function visibleIndices() {
    const out = [];
    for (let i = 0; i < state.links.length; i++) {
      const l = state.links[i];
      if (state.filter === "all" || l.status === state.filter) out.push(i);
    }
    return out;
  }

  function renderRow(idx) {
    const tr = document.querySelector(`tr[data-idx="${idx}"]`);
    if (!tr) return;
    const l = state.links[idx];
    tr.querySelector(".st").innerHTML = statusBadge(l.status);
    tr.querySelector(".msg").textContent = l.message || "";
    tr.querySelector(".time").textContent = fmtTime(l.checkedAt);
  }

  function renderRows() {
    const tbody = $("rows");
    const idxs = visibleIndices();
    if (!idxs.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty">No links to show.</td></tr>`;
      return;
    }
    tbody.innerHTML = idxs
      .map((i) => {
        const l = state.links[i];
        const checkBtn = staticMode
          ? ""
          : `<button class="ghost" data-act="check">Check</button>`;
        return `
          <tr data-idx="${i}">
            <td class="st">${statusBadge(l.status)}</td>
            <td class="url">
              <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.url)}</a>
              <div class="msg" style="color:var(--muted);font-size:12px;margin-top:4px">${escapeHtml(l.message || "")}</div>
            </td>
            <td class="time">${fmtTime(l.checkedAt)}</td>
            <td class="actions">
              <a class="open-link" href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">Open</a>
              <button class="ghost" data-act="copy" title="Copy this link to clipboard">Copy</button>
              ${checkBtn}
              <button class="mark-live" data-act="mark-live" title="Mark this link live">✓ Live</button>
              <button class="mark-dead" data-act="mark-dead" title="Mark this link dead">✕ Dead</button>
              <button class="danger" data-act="remove">Remove</button>
            </td>
          </tr>`;
      })
      .join("");

    tbody.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const i = Number(tr.dataset.idx);
        const act = btn.dataset.act;
        if (act === "check") checkOne(i);
        else if (act === "remove") removeAt(i);
        else if (act === "mark-live") markStatus(i, "live");
        else if (act === "mark-dead") markStatus(i, "dead");
        else if (act === "copy") {
          const link = state.links[i];
          if (!link) return;
          copyTextToClipboard(link.url).then((ok) => {
            flash(ok ? "Copied link to clipboard." : "Couldn't copy link.");
          });
        }
      });
    });
  }

  function render() {
    renderStats();
    renderRows();
    renderCodeblock();
  }

  function codeblockLinks() {
    const f = state.codeblockFilter || "live";
    if (f === "all") return state.links.slice();
    return state.links.filter((l) => l.status === f);
  }

  function renderCodeblock() {
    const links = codeblockLinks();
    const label = $("codeblockLabel");
    const body = $("codeblockBody");
    const empty = $("codeblockEmpty");
    if (label) {
      label.textContent = `Code · ${links.length} link${links.length === 1 ? "" : "s"}`;
    }
    if (body && empty) {
      if (!links.length) {
        body.textContent = "";
        body.style.display = "none";
        empty.style.display = "block";
      } else {
        // Two blank lines between URLs (so 3 newlines), matching the .txt and clipboard exports.
        body.textContent = links.map((l) => l.url).join("\n\n\n");
        body.style.display = "block";
        empty.style.display = "none";
      }
    }
    const tb = $("codeblockToolbar");
    if (tb) {
      tb.querySelectorAll(".seg").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.cbFilter === state.codeblockFilter);
      });
    }
  }

  function removeAt(i) {
    state.links.splice(i, 1);
    save();
    render();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function updateAutoStatus() {
    const el = $("autocheckStatus");
    const btn = $("btnToggleAuto");
    if (staticMode) {
      el.className = "badge unknown";
      el.textContent = "manual mode";
      btn.textContent = "Auto-check (offline)";
      return;
    }
    if (state.autoOn) {
      const suffix = inFlight ? ` (checking ${inFlight})` : "";
      el.className = "badge checking";
      el.textContent = `auto-check on${suffix}`;
      btn.textContent = "Stop auto-check";
    } else {
      el.className = "badge pending";
      el.textContent = "auto-check off";
      btn.textContent = "Start auto-check";
    }
  }

  async function pingServer() {
    const el = $("serverStatus");
    let online = false;
    try {
      const r = await fetch("api/health", { cache: "no-store" });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        if (data && data.ok) online = true;
      }
    } catch (e) {}
    if (online) {
      el.className = "badge live";
      el.textContent = "local server: connected";
      if (staticMode || !modeKnown) {
        staticMode = false;
        modeKnown = true;
        applyModeUI();
      }
      return true;
    }
    el.className = "badge unknown";
    el.textContent = "static mode (no auto-check)";
    if (!staticMode || !modeKnown) {
      staticMode = true;
      modeKnown = true;
      if (state.autoOn) stopAuto();
      applyModeUI();
    }
    return false;
  }

  function applyModeUI() {
    const idsToToggle = ["btnCheckAll", "btnToggleAuto", "intervalSec"];
    for (const id of idsToToggle) {
      const el = $(id);
      if (el) el.disabled = staticMode;
    }
    const note = $("footerNote");
    if (note) {
      note.innerHTML = staticMode
        ? `Static mode: browsers can't fetch Google directly. Click <strong>Open</strong> to view a link, then mark it <span class="badge live">live</span> or <span class="badge dead">dead</span>. Paste / clean / dedupe / .txt download all still work.`
        : `Auto-check pings each link via the local Python proxy (so CORS is bypassed). Status: <span class="badge live">live</span> still claimable &middot; <span class="badge dead">dead</span> redeemed/expired/404 &middot; <span class="badge unknown">unknown</span> network/timeout, retry`;
    }
    renderRows();
    updateAutoStatus();
  }

  // --------- wire-up ---------
  function wire() {
    const pasteBox = $("pasteBox");
    const updatePreview = () => {
      const urls = extractUrls(pasteBox.value);
      $("parsePreview").textContent = urls.length
        ? `${urls.length} URL(s) detected.`
        : "No URLs detected yet.";
    };
    pasteBox.addEventListener("input", updatePreview);
    updatePreview();

    $("btnAdd").addEventListener("click", () => {
      const urls = extractUrls(pasteBox.value);
      const { added, dupes } = addLinks(urls);
      flash(`Added ${added}, ${dupes} duplicate(s) skipped.`);
    });
    $("btnAddClear").addEventListener("click", () => {
      const urls = extractUrls(pasteBox.value);
      const { added, dupes } = addLinks(urls);
      pasteBox.value = "";
      updatePreview();
      flash(`Added ${added}, ${dupes} duplicate(s) skipped.`);
    });

    $("btnCheckAll").addEventListener("click", () => checkAll(4));
    $("btnToggleAuto").addEventListener("click", () => (state.autoOn ? stopAuto() : startAuto()));

    $("intervalSec").value = String(state.intervalSec);
    $("intervalSec").addEventListener("change", () => {
      const v = Math.max(10, Number($("intervalSec").value) || 120);
      state.intervalSec = v;
      $("intervalSec").value = String(v);
      save();
      if (state.autoOn) {
        stopAuto();
        startAuto();
      }
    });

    $("btnDownloadLive").addEventListener("click", () => {
      const live = state.links.filter((l) => l.status === "live");
      downloadTxt(`stock-chker-live-${stamp()}.txt`, live);
    });
    $("btnDownloadAll").addEventListener("click", () => {
      downloadTxt(`stock-chker-all-${stamp()}.txt`, state.links);
    });
    $("btnCopyLive").addEventListener("click", () => {
      const live = state.links.filter((l) => l.status === "live");
      copyLinksToClipboard(live, "live");
    });
    $("btnCopyAll").addEventListener("click", () => {
      copyLinksToClipboard(state.links, "all");
    });

    // Code-block view: filter chips + the big Copy button at the corner.
    const cbToolbar = $("codeblockToolbar");
    if (cbToolbar) {
      cbToolbar.querySelectorAll(".seg").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.codeblockFilter = btn.dataset.cbFilter;
          save();
          renderCodeblock();
        });
      });
    }
    const btnCb = $("btnCodeblockCopy");
    if (btnCb) {
      btnCb.addEventListener("click", () => {
        copyLinksToClipboard(codeblockLinks(), state.codeblockFilter || "live");
      });
    }
    $("btnRemoveDead").addEventListener("click", () => {
      const before = state.links.length;
      state.links = state.links.filter((l) => l.status !== "dead");
      save();
      render();
      flash(`Removed ${before - state.links.length} dead link(s).`);
    });
    $("btnClearAll").addEventListener("click", () => {
      if (!state.links.length) return;
      if (!confirm("Clear ALL links? This cannot be undone.")) return;
      state.links = [];
      save();
      render();
    });
  }

  function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  let flashTimer = null;
  function flash(msg) {
    const el = $("parsePreview");
    el.textContent = msg;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      el.textContent = "";
    }, 3500);
  }

  // --------- init ---------
  load();
  wire();
  render();
  updateAutoStatus();
  pingServer();
  setInterval(pingServer, 30000);
})();
