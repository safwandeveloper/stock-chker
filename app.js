/* stock-chker - all client logic.
 * No build step, no framework, no dependencies.
 * Persists to localStorage so reloads don't lose your list.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "stockchker:v1";
  const URL_REGEX = /https?:\/\/[^\s<>"'`\\]+/gi;

  /** @type {{links: Array<{url:string,status:string,message:string,statusCode:number,finalUrl:string,addedAt:number,checkedAt:number}>, filter:string, intervalSec:number, autoOn:boolean}} */
  const state = {
    links: [],
    filter: "all",
    intervalSec: 120,
    autoOn: false,
  };

  let autoTimer = null;
  let inFlight = 0;

  // --------- persistence ---------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.links)) {
        state.links = parsed.links.map(normalizeLink);
      }
      if (typeof parsed.intervalSec === "number") state.intervalSec = parsed.intervalSec;
      if (typeof parsed.filter === "string") state.filter = parsed.filter;
    } catch (e) {
      console.warn("Failed to load state", e);
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
  function extractUrls(text) {
    if (!text) return [];
    const out = [];
    const seen = new Set();
    const matches = text.match(URL_REGEX) || [];
    for (let raw of matches) {
      // strip common trailing punctuation that isn't part of a URL
      raw = raw.replace(/[)\],.;!?>]+$/g, "");
      if (!raw) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
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
    const link = state.links[idx];
    if (!link) return;
    link.status = "checking";
    link.message = "";
    inFlight += 1;
    renderRow(idx);
    updateAutoStatus();
    try {
      const r = await fetch("/api/check?url=" + encodeURIComponent(link.url));
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
        return `
          <tr data-idx="${i}">
            <td class="st">${statusBadge(l.status)}</td>
            <td class="url">
              <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.url)}</a>
              <div class="msg" style="color:var(--muted);font-size:12px;margin-top:4px">${escapeHtml(l.message || "")}</div>
            </td>
            <td class="time">${fmtTime(l.checkedAt)}</td>
            <td class="actions">
              <button class="ghost" data-act="check">Check</button>
              <button class="danger" data-act="remove">Remove</button>
            </td>
          </tr>`;
      })
      .join("");

    tbody.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const i = Number(tr.dataset.idx);
        if (btn.dataset.act === "check") checkOne(i);
        else if (btn.dataset.act === "remove") removeAt(i);
      });
    });
  }

  function render() {
    renderStats();
    renderRows();
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
    try {
      const r = await fetch("/api/health");
      if (r.ok) {
        el.className = "badge live";
        el.textContent = "server ok";
        return true;
      }
    } catch (e) {}
    el.className = "badge dead";
    el.textContent = "server offline";
    return false;
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
