// main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

/* ========= PASSWORD PROTECT ========= */
// Pakai password statis sesuai permintaan (idealnya dari ENV, tapi di sini hardcode).
const ADMIN_PASSWORD = "MemoBuild25";
function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}
function isAuthorized(password) {
  return timingSafeEqualStr(password, ADMIN_PASSWORD);
}

/* ========= UTIL TANGGAL & PATH ========= */
function parseTanggalFleksibel(input) {
  if (!input) return null;
  let d = new Date(input);
  if (!isNaN(d)) return d;

  const m1 = String(input).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) {
    const [_, dd, mm, yyyy] = m1;
    d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (!isNaN(d)) return d;
  }

  const bulanMap = { januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5, juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11 };
  const m2 = String(input)
    .toLowerCase()
    .match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (m2) {
    const [_, dd, namaBulan, yyyy] = m2;
    const mm = bulanMap[namaBulan];
    if (mm !== undefined) {
      d = new Date(Number(yyyy), Number(mm), Number(dd));
      if (!isNaN(d)) return d;
    }
  }
  return null;
}
function getBaseMemoDir() {
  const docsDir = app.getPath("documents");
  return path.join(docsDir, "MemoAHM");
}

/* ========= WINDOW ========= */
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  const navPath = path.join(__dirname, "nav.html");
  const indexPath = path.join(__dirname, "index.html");
  const entryHtml = fs.existsSync(navPath) ? navPath : indexPath;

  win.on("ready-to-show", () => win.show());
  win.loadFile(entryHtml).catch((err) => console.error("Gagal load HTML:", err));
}

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.memo.ahm");
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ========= SIMPAN PDF (per-bulan) & KUNCI NOMOR ========= */
ipcMain.handle("save-pdf", async (_event, payload) => {
  try {
    const { base64Data, filename, tanggalMemo, nomor, hal, dari, logDibuatOleh } = payload || {};
    const parsed = parseTanggalFleksibel(tanggalMemo) || new Date();
    const yyyy = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, "0");

    const baseDir = getBaseMemoDir();
    const monthDir = path.join(baseDir, `${yyyy}-${mm}`);
    fs.mkdirSync(monthDir, { recursive: true });

    const safeName = String(filename || "Memo.pdf").replace(/[\\/:*?"<>|]/g, "-");
    const pdfBase64 = String(base64Data || "").replace(/^data:application\/pdf;base64,/, "");
    const buffer = Buffer.from(pdfBase64, "base64");
    const filePath = path.join(monthDir, safeName);
    fs.writeFileSync(filePath, buffer);

    // tulis/ubah log per-bulan & tandai nomor disabled: true
    const logPath = path.join(monthDir, "memo-log.json");
    let log = [];
    try {
      if (fs.existsSync(logPath)) log = JSON.parse(fs.readFileSync(logPath, "utf8") || "[]");
    } catch {
      log = [];
    }

    const upsert = (arr, nomorKey, updater) => {
      const idx = arr.findIndex((l) => (l.nomor || "").trim() === (nomorKey || "").trim());
      if (idx >= 0) arr[idx] = { ...arr[idx], ...updater };
      else arr.push({ nomor: nomorKey, ...updater });
    };
    upsert(log, nomor || "", {
      disabled: true,
      hal: hal || "",
      dari: dari || "",
      tanggal: tanggalMemo || parsed.toISOString().slice(0, 10),
      file: safeName,
      dibuat_oleh: logDibuatOleh || "",
      saved_at: new Date().toISOString(),
    });

    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
    return filePath;
  } catch (err) {
    console.error("save-pdf error:", err);
    return null;
  }
});

/* ========= ENABLE SEMUA NOMOR (BUTUH PASSWORD) ========= */
ipcMain.handle("enable-all-nomor", async (_e, { password } = {}) => {
  try {
    if (!isAuthorized(password)) return { ok: false, code: "AUTH", msg: "Password salah." };

    const baseDir = getBaseMemoDir();
    if (!fs.existsSync(baseDir)) return { ok: true, changed: 0, monthsProcessed: 0 };

    const candidates = [];
    const rootLog = path.join(baseDir, "memo-log.json");
    if (fs.existsSync(rootLog)) candidates.push(rootLog);

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const d of entries) {
      if (d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name)) {
        const lp = path.join(baseDir, d.name, "memo-log.json");
        if (fs.existsSync(lp)) candidates.push(lp);
      }
    }

    let changed = 0,
      monthsProcessed = 0;
    for (const logPath of candidates) {
      let log;
      try {
        log = JSON.parse(fs.readFileSync(logPath, "utf8") || "[]");
      } catch {
        log = [];
      }
      if (!Array.isArray(log) || log.length === 0) {
        monthsProcessed++;
        continue;
      }

      let localChanged = 0;
      const newLog = log.map((item) => (item && item.disabled ? (localChanged++, { ...item, disabled: false }) : item));
      if (localChanged > 0) {
        fs.writeFileSync(logPath, JSON.stringify(newLog, null, 2), "utf8");
        changed += localChanged;
      }
      monthsProcessed++;
    }
    return { ok: true, changed, monthsProcessed };
  } catch (e) {
    console.error("enable-all-nomor error:", e);
    return { ok: false, code: "ERR", msg: String(e) };
  }
});

/* ========= HAPUS LOG (BUTUH PASSWORD) ========= */
// scope: "all" = hapus semua log; atau "month" dengan ym "YYYY-MM"
ipcMain.handle("delete-logs", async (_e, { password, scope, ym } = {}) => {
  try {
    if (!isAuthorized(password)) return { ok: false, code: "AUTH", msg: "Password salah." };

    const baseDir = getBaseMemoDir();
    if (!fs.existsSync(baseDir)) return { ok: true, deleted: 0 };

    const targets = [];
    if (scope === "month" && /^\d{4}-\d{2}$/.test(ym || "")) {
      const p = path.join(baseDir, ym, "memo-log.json");
      if (fs.existsSync(p)) targets.push(p);
    } else if (scope === "all") {
      const rootLog = path.join(baseDir, "memo-log.json");
      if (fs.existsSync(rootLog)) targets.push(rootLog);
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const d of entries) {
        if (d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name)) {
          const lp = path.join(baseDir, d.name, "memo-log.json");
          if (fs.existsSync(lp)) targets.push(lp);
        }
      }
    } else {
      return { ok: false, code: "BAD_REQ", msg: "scope/ym tidak valid." };
    }

    let deleted = 0;
    for (const p of targets) {
      try {
        fs.unlinkSync(p);
        deleted++;
      } catch {}
    }
    return { ok: true, deleted };
  } catch (e) {
    console.error("delete-logs error:", e);
    return { ok: false, code: "ERR", msg: String(e) };
  }
});
