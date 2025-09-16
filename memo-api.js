// ===== memo-api.js (anti-preflight, fail-closed, reserve + finalize) =====
//
// HTML harus set CONFIG sebelum file ini diload:
//   window.MEMO_API_ENABLED = true
//   window.MEMO_API_BASE = "https://script.google.com/macros/s/XXXX/exec"
//   window.MEMO_API_TIMEOUT_MS = 7000
//   // window.MEMO_API_TOKEN = "opsional";

// ---------- FETCH WRAPPER (anti preflight) ----------
async function memoApiFetch(path = "", options = {}) {
  if (!window.MEMO_API_ENABLED || !window.MEMO_API_BASE) {
    throw new Error("API disabled");
  }
  const base = window.MEMO_API_BASE; // /exec
  let url = base;
  if (path) {
    const sep = base.includes("?") ? "&" : "?";
    const clean = path.startsWith("?") || path.startsWith("&") ? path.slice(1) : path;
    url = base + sep + clean;
  }

  const ctrl = new AbortController();
  const timeout = Number(window.MEMO_API_TIMEOUT_MS || 7000);
  const t = setTimeout(() => ctrl.abort(), timeout);

  const init = {
    method: options.method || "GET",
    headers: { ...(options.headers || {}) },
    body: options.body,
    signal: ctrl.signal,
    mode: "cors",
    credentials: "omit", // untuk Web App "Anyone"
    referrerPolicy: "no-referrer",
  };
  if (init.method.toUpperCase() === "POST") {
    // text/plain → tidak memicu preflight CORS
    init.headers["Content-Type"] = init.headers["Content-Type"] || "text/plain;charset=utf-8";
  }

  try {
    const res = await fetch(url, init);
    clearTimeout(t);

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${bodyText.slice(0, 200)}`);
    }

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response (not JSON): ${text.slice(0, 200)}`);
    }
  } catch (e) {
    clearTimeout(t);
    console.error("[memoApiFetch] gagal:", e);
    throw e;
  }
}

// ---------- Endpoints client ----------
async function getUsedNumbersFromServer(year) {
  const tokenQS = window.MEMO_API_TOKEN ? `&token=${encodeURIComponent(window.MEMO_API_TOKEN)}` : "";
  const data = await memoApiFetch(`?route=used&year=${encodeURIComponent(year)}${tokenQS}`, { method: "GET" });
  if (!data || !data.ok) throw new Error(data?.error || "API error");
  return Array.isArray(data.used) ? data.used : [];
}

async function reserveNumberOnServer({ year, nomor3Digit, nomorPenuh, pemakai }) {
  const payload = { route: "reserve", year, nomor3Digit, nomorPenuh, pemakai };
  if (window.MEMO_API_TOKEN) payload.token = window.MEMO_API_TOKEN;
  return await memoApiFetch("", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
}

async function finalizeNumberOnServer({ year, nomor3Digit, nomorPenuh, pemakai }) {
  const payload = { route: "finalize", year, nomor3Digit, nomorPenuh, pemakai };
  if (window.MEMO_API_TOKEN) payload.token = window.MEMO_API_TOKEN;
  return await memoApiFetch("", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
}

// ---------- Helper: disable dropdown berdasarkan data server + lokal ----------
// ---------- Helper: disable dropdown berdasarkan data server + lokal ----------
async function syncDisableDropdownByServer() {
  const dd = document.getElementById("nomorDropdown");
  const tglEl = document.getElementById("tanggal");
  if (!dd || !tglEl) return;

  // Tahun aktif dari input tanggal (default: tahun sekarang)
  const d = tglEl.value ? new Date(tglEl.value) : new Date();
  const year = String(d.getFullYear());

  // Coba ambil daftar used dari server; jika berhasil, anggap itu "source of truth"
  let usedServer = null;
  try {
    usedServer = await getUsedNumbersFromServer(year); // array seperti ['001','002'...]
    // normalisasi -> bentuk "001/" dan tulis ke localStorage agar klien lain yang hidup
    const normalized = usedServer.map((x) => String(x).padStart(3, "0") + "/");
    try {
      localStorage.setItem("usedNomorMemo", JSON.stringify(normalized));
    } catch (e) {
      // ignore bila localStorage gagal
    }
  } catch (err) {
    // Jika gagal ambil server, biarkan usedServer = null (fallback ke cache lokal)
    usedServer = null;
    // console.warn('sync: gagal ambil dari server, gunakan cache lokal', err);
  }

  // Ambil cache lokal (selalu baca), tapi kalau server berhasil, kita akan gunakan hasil server saja
  let usedLocal = [];
  try {
    usedLocal = JSON.parse(localStorage.getItem("usedNomorMemo") || "[]");
  } catch (e) {
    usedLocal = [];
  }

  // Jika server berhasil -> gunakan hanya server; jika tidak -> gunakan cache lokal
  const usedSet = new Set(usedServer !== null ? usedServer.map((x) => String(x).padStart(3, "0") + "/") : usedLocal);

  for (const opt of dd.options) {
    const val = String(opt.value || "");
    if (!val) continue;
    opt.disabled = usedSet.has(val);
    if (opt.disabled && !opt.textContent.includes("(sudah dipakai)")) {
      opt.textContent += " (sudah dipakai)";
    }
  }

  if (dd.value && dd.options[dd.selectedIndex]?.disabled) {
    dd.value = "";
  }
}

// ---------- Reserve sebelum lanjut ke hasil.html ----------
async function beforeProceedReserve() {
  if (!window.MEMO_API_ENABLED) return true; // jika API dimatikan, lanjut saja

  const dd = document.getElementById("nomorDropdown");
  const manual = document.getElementById("nomorManual");
  const tglEl = document.getElementById("tanggal");
  const namaEl = document.getElementById("diajukanNama");

  if (!dd || !manual || !tglEl) return true;

  const nomorDropdown = String(dd.value || ""); // "003/"
  if (!nomorDropdown) return true; // tidak memilih nomor → biarkan lanjut
  const nomorManual = String(manual.value || ""); // "AHMOSM/P4/IX/2025"
  const nomorPenuh = nomorDropdown + nomorManual; // "003/AHMOSM/P4/IX/2025"
  const nomor3Digit = nomorDropdown.slice(0, 3);

  const pemakai = (namaEl?.value || "anonymous").trim();
  const d = tglEl.value ? new Date(tglEl.value) : new Date();
  const year = String(d.getFullYear());

  try {
    const resp = await reserveNumberOnServer({ year, nomor3Digit, nomorPenuh, pemakai });

    if (resp && resp.ok) {
      // catat ke cache lokal agar UX cepat
      try {
        const used = JSON.parse(localStorage.getItem("usedNomorMemo") || "[]");
        const val = nomor3Digit + "/";
        if (!used.includes(val)) {
          used.push(val);
          localStorage.setItem("usedNomorMemo", JSON.stringify(used));
        }
      } catch {}
      return true;
    }

    if (resp && resp.reason === "DUPLICATE") {
      alert(`Nomor ${nomor3Digit} sudah dipakai tahun ${year}. Pilih nomor lain.`);
      // disable opsi yang bentrok
      const opt = [...dd.options].find((o) => String(o.value || "").startsWith(nomor3Digit));
      if (opt) {
        opt.disabled = true;
        if (!opt.textContent.includes("(sudah dipakai)")) opt.textContent += " (sudah dipakai)";
      }
      dd.value = "";
      return false;
    }

    alert("Gagal reservasi nomor ke server. Coba lagi.");
    return false;
  } catch (e) {
    console.warn("Reserve gagal:", e.message || e);
    alert("Tidak bisa menghubungi server nomor. Coba lagi.");
    return false; // fail-closed: jangan lanjut kalau server error
  }
}

// ---------- Admin Reset Semua Nomor ----------
async function adminResetOnServer({ year, password }) {
  const payload = { route: "adminreset", year, password };
  if (window.MEMO_API_TOKEN) payload.token = window.MEMO_API_TOKEN;
  return await memoApiFetch("", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "text/plain;charset=utf-8" },
  });
}

async function addLogOnServer({ nomor, perihal, dibuatOleh, tanggal }) {
  const payload = { route: "log_add", nomor, perihal, dibuatOleh, tanggal };
  if (window.MEMO_API_TOKEN) payload.token = window.MEMO_API_TOKEN;
  return await memoApiFetch("", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "text/plain;charset=utf-8" },
  });
}

window.adminResetOnServer = adminResetOnServer;
window.addLogOnServer = addLogOnServer; // <--- EKSPOR BARU

// ---------- Ekspor ke global (WAJIB di paling bawah) ----------
window.memoApiFetch = memoApiFetch;
window.getUsedNumbersFromServer = getUsedNumbersFromServer;
window.reserveNumberOnServer = reserveNumberOnServer;
window.finalizeNumberOnServer = finalizeNumberOnServer;
window.syncDisableDropdownByServer = syncDisableDropdownByServer;
window.beforeProceedReserve = beforeProceedReserve;
