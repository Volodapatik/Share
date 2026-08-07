"use strict";
/*
 * QR-Bridge — експериментальна оптична передача файлів через потік QR-кодів.
 *
 * Формат кадру (бінарний, вшивається у QR у byte-mode):
 *
 *  DATA-кадр (type=1):
 *   [0]  magic     = 0xFA
 *   [1]  version   = 1
 *   [2]  type      = 1
 *   [3-4]  sessionId   (uint16 BE)
 *   [5-6]  K           (uint16 BE)  — загальна кількість вихідних блоків
 *   [7-8]  blockSize    (uint16 BE)  — розмір блоку в байтах
 *   [9-12] esi          (uint32 BE)  — encoding symbol id (номер кадру фонтану)
 *   [13..] payload       (blockSize байт) — XOR обраних блоків
 *
 *  META-кадр (type=0), транслюється періодично поруч із DATA-кадрами:
 *   [0]  magic, [1] version, [2] type=0
 *   [3-4]  sessionId
 *   [5-6]  K
 *   [7-8]  blockSize
 *   [9-12] fileSize    (uint32 BE)
 *   [13-16] crc32       (uint32 BE)
 *   [17]   mimeLen, [18..] mime bytes
 *   [.]    nameLen,  [..] name bytes (utf-8)
 *
 * Кодування — систематичний fountain-код:
 *  esi < K   -> кадр = вихідний блок №esi без змін (пряма передача)
 *  esi >= K  -> "репейр"-кадр: XOR degree(esi) блоків, обраних детерміновано
 *               псевдовипадковим генератором, зашитим (sessionId, esi).
 * Завдяки цьому приймач може відновити файл навіть при втраті частини кадрів —
 * достатньо отримати будь-які K "незалежних" (лінійно корисних) символів.
 */

// ---------------------------------------------------------------------------
// Утиліти: CRC32, псевдовипадковий генератор, розподіл ступеня фонтану
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Детермінований 32-бітний PRNG (mulberry32) — і відправник, і приймач
// отримують однакову послідовність з того самого seed, тож індекси блоків
// репейр-символу не потрібно передавати явно — обидві сторони їх обчислюють.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Спрощений розподіл ступеня (натхненний robust soliton, але без табличної
// точності — для навчального / експериментального застосунку цього достатньо
// в парі з систематичним префіксом).
function pickDegree(rand, K) {
  const r = rand();
  if (r < 0.45) return 1;
  if (r < 0.72) return 2;
  if (r < 0.86) return 3;
  const maxD = Math.max(4, Math.min(K, 10));
  return 4 + Math.floor(rand() * (maxD - 3));
}

// Для esi>=K повертає список індексів вихідних блоків, XOR яких формує символ.
function symbolIndices(sessionId, esi, K) {
  if (esi < K) return [esi]; // систематична частина — блок як є
  const seed = ((sessionId * 2654435761) ^ (esi * 40503) ^ (esi >>> 3)) >>> 0;
  const rand = mulberry32(seed);
  const d = Math.min(pickDegree(rand, K), K);
  const set = new Set();
  while (set.size < d) set.add(Math.floor(rand() * K));
  return Array.from(set);
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

// ---------------------------------------------------------------------------
// Кодування / декодування кадрів у бінарний Uint8Array
// ---------------------------------------------------------------------------

const MAGIC = 0xFA;
const VERSION = 1;

function encodeDataFrame(sessionId, K, blockSize, esi, payload) {
  const buf = new Uint8Array(13 + blockSize);
  const dv = new DataView(buf.buffer);
  buf[0] = MAGIC; buf[1] = VERSION; buf[2] = 1;
  dv.setUint16(3, sessionId);
  dv.setUint16(5, K);
  dv.setUint16(7, blockSize);
  dv.setUint32(9, esi);
  buf.set(payload, 13);
  return buf;
}

function encodeMetaFrame(sessionId, K, blockSize, fileSize, crc, mime, name) {
  const mimeB = new TextEncoder().encode(mime.slice(0, 60));
  const nameB = new TextEncoder().encode(name.slice(0, 80));
  const buf = new Uint8Array(17 + 1 + mimeB.length + 1 + nameB.length);
  const dv = new DataView(buf.buffer);
  buf[0] = MAGIC; buf[1] = VERSION; buf[2] = 0;
  dv.setUint16(3, sessionId);
  dv.setUint16(5, K);
  dv.setUint16(7, blockSize);
  dv.setUint32(9, fileSize);
  dv.setUint32(13, crc);
  let off = 17;
  buf[off++] = mimeB.length; buf.set(mimeB, off); off += nameB.length;
  buf[off++] = nameB.length; buf.set(nameB, off); off += nameB.length;
  return buf;
}

function decodeFrame(bytes) {
  if (!bytes || bytes.length < 3 || bytes[0] !== MAGIC || bytes[1] !== VERSION) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[2];
  if (type === 1) {
    if (bytes.length < 13) return null;
    return {
      type: 1,
      sessionId: dv.getUint16(3),
      K: dv.getUint16(5),
      blockSize: dv.getUint16(7),
      esi: dv.getUint32(9),
      payload: bytes.subarray(13),
    };
  }
  if (type === 0) {
    if (bytes.length < 18) return null;
    let off = 17;
    const mimeLen = bytes[off++];
    const mime = new TextDecoder().decode(bytes.subarray(off, off + mimeLen)); off += mimeLen;
    const nameLen = bytes[off++];
    const name = new TextDecoder().decode(bytes.subarray(off, off + nameLen)); off += nameLen;
    return {
      type: 0,
      sessionId: dv.getUint16(3),
      K: dv.getUint16(5),
      blockSize: dv.getUint16(7),
      fileSize: dv.getUint32(9),
      crc: dv.getUint32(13),
      mime, name,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Пілінг-декодер fountain-коду (peeling decoder)
// ---------------------------------------------------------------------------

class FountainDecoder {
  constructor(K, blockSize) {
    this.K = K;
    this.blockSize = blockSize;
    this.blocks = new Array(K).fill(null);
    this.solved = 0;
    this.pending = []; // {idxSet: Set<number>, data: Uint8Array}
    this.seenEsi = new Set();
    this.newBytesSinceTick = 0; // для лічильника goodput
  }

  get done() { return this.solved === this.K; }

  addSymbol(esi, indices, data) {
    if (this.seenEsi.has(esi)) return false; // дублікат кадру — ігноруємо
    this.seenEsi.add(esi);

    let idxSet = new Set(indices);
    let buf = data.slice();

    // Виключаємо вже відомі блоки з рівняння (message passing)
    for (const idx of Array.from(idxSet)) {
      if (this.blocks[idx]) {
        xorInto(buf, this.blocks[idx]);
        idxSet.delete(idx);
      }
    }

    if (idxSet.size === 0) return false; // нічого нового
    if (idxSet.size === 1) {
      this._resolve(idxSet.values().next().value, buf);
    } else {
      this.pending.push({ idxSet, data: buf });
      this._cascade();
    }
    return true;
  }

  _resolve(idx, data) {
    if (this.blocks[idx]) return;
    this.blocks[idx] = data;
    this.solved++;
    this.newBytesSinceTick += data.length;
    this._cascade();
  }

  _cascade() {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const sym = this.pending[i];
        for (const idx of Array.from(sym.idxSet)) {
          if (this.blocks[idx]) {
            xorInto(sym.data, this.blocks[idx]);
            sym.idxSet.delete(idx);
          }
        }
        if (sym.idxSet.size === 0) {
          this.pending.splice(i, 1);
        } else if (sym.idxSet.size === 1) {
          const idx = sym.idxSet.values().next().value;
          this.pending.splice(i, 1);
          this._resolve(idx, sym.data);
          progress = true;
        }
      }
    }
  }

  assemble(fileSize) {
    const out = new Uint8Array(fileSize);
    for (let i = 0; i < this.K; i++) {
      const start = i * this.blockSize;
      const end = Math.min(start + this.blockSize, fileSize);
      out.set(this.blocks[i].subarray(0, end - start), start);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// UI: перемикач режимів
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

$("tabSender").onclick = () => setMode("sender");
$("tabReceiver").onclick = () => setMode("receiver");

function setMode(mode) {
  $("tabSender").classList.toggle("active", mode === "sender");
  $("tabReceiver").classList.toggle("active", mode === "receiver");
  $("panelSender").classList.toggle("active", mode === "sender");
  $("panelReceiver").classList.toggle("active", mode === "receiver");
  if (mode !== "receiver") stopScan();
}

function fmtTime(sec) {
  sec = Math.floor(sec);
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// ВІДПРАВНИК
// ---------------------------------------------------------------------------

let sendState = null; // активна сесія трансляції

$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("fileLabel").textContent = `${file.name} (${(file.size / 1024).toFixed(1)} КБ)`;
  $("btnStartSend").disabled = false;
  sendState = { file, running: false };
});

$("btnStartSend").onclick = async () => {
  if (!sendState || !sendState.file) return;
  const file = sendState.file;
  const blockSize = parseInt($("blockSizeSel").value, 10);
  const fps = parseInt($("fpsSel").value, 10);

  const buf = new Uint8Array(await file.arrayBuffer());
  const K = Math.ceil(buf.length / blockSize) || 1;
  const crc = crc32(buf);
  const sessionId = Math.floor(Math.random() * 65536);

  // Нарізаємо файл на K блоків фіксованого розміру (останній доповнюємо нулями)
  const blocks = [];
  for (let i = 0; i < K; i++) {
    const b = new Uint8Array(blockSize);
    const start = i * blockSize;
    b.set(buf.subarray(start, Math.min(start + blockSize, buf.length)));
    blocks.push(b);
  }

  sendState = {
    file, blocks, K, blockSize, crc, sessionId, fps,
    fileSize: buf.length,
    esi: 0,
    running: true,
    frameInterval: 1000 / fps,
    lastFrameTime: 0,
    fpsCounter: 0, fpsLastCheck: performance.now(), fpsDisplay: 0,
    startTime: performance.now(),
    bytesSent: 0, goodputLastCheck: performance.now(), goodputDisplay: 0,
  };

  $("btnStartSend").disabled = true;
  $("btnStopSend").disabled = false;
  $("fileInput").disabled = true;
  $("sHint").textContent = "Трансляція триває… наведіть камеру приймача на екран.";
  $("sHint").className = "hint";

  requestAnimationFrame(sendLoop);
};

$("btnStopSend").onclick = () => {
  if (sendState) sendState.running = false;
  $("btnStartSend").disabled = false;
  $("btnStopSend").disabled = true;
  $("fileInput").disabled = false;
  $("sHint").textContent = "Трансляцію зупинено.";
};

function sendLoop(now) {
  if (!sendState || !sendState.running) return;
  // Захист: якщо всередині ітерації станеться виняток (наприклад, бібліотека
  // QR не завантажилась) — цикл НЕ повинен мовчки зупинятись. Помилка
  // показується у підказці й у видимому банері, а цикл продовжується.
  try {
    sendTick(now);
  } catch (e) {
    console.error("sendLoop error:", e);
    $("sHint").textContent = "⚠ Помилка трансляції: " + e.message;
    $("sHint").className = "hint error";
  }
  requestAnimationFrame(sendLoop);
}

function sendTick(now) {
  const st = sendState;

  if (now - st.lastFrameTime >= st.frameInterval) {
    st.lastFrameTime = now;

    // Кожен 8-й кадр — метадані файлу (ім'я, тип, розмір, контрольна сума)
    const isMeta = (st.esi % 8 === 7);
    let frameBytes;
    if (isMeta) {
      frameBytes = encodeMetaFrame(
        st.sessionId, st.K, st.blockSize, st.fileSize, st.crc,
        st.file.type || "application/octet-stream", st.file.name
      );
    } else {
      const indices = symbolIndices(st.sessionId, st.esi, st.K);
      const payload = new Uint8Array(st.blockSize);
      for (const idx of indices) xorInto(payload, st.blocks[idx]);
      frameBytes = encodeDataFrame(st.sessionId, st.K, st.blockSize, st.esi, payload);
      st.esi++;
      // esi продовжує рости нескінченно — repair-кадри дають дедалі нові
      // лінійні комбінації, тож приймач зрештою набере потрібні K символів.
    }

    renderQR(frameBytes);

    st.bytesSent += frameBytes.length;
    st.fpsCounter++;

    // Прогрес показуємо як частку унікальних систематичних esi, вже відправлених,
    // по модулю циклу (орієнтовний індикатор активності, не точний прогрес приймача)
    const cycleProgress = Math.min(100, Math.round(((st.esi % (st.K * 2)) / st.K) * 100));
    $("sProgress").textContent = cycleProgress + "%";
    $("sProgressBar").style.width = cycleProgress + "%";
  }

  // Оновлення статистики раз на секунду
  if (now - st.fpsLastCheck >= 1000) {
    st.fpsDisplay = st.fpsCounter;
    st.fpsCounter = 0;
    st.fpsLastCheck = now;
    const kb = st.bytesSent / 1024;
    st.goodputDisplay = kb.toFixed(1);
    st.bytesSent = 0;

    $("sFps").textContent = st.fpsDisplay;
    $("sGoodput").textContent = st.goodputDisplay;
    $("sTimer").textContent = fmtTime((now - st.startTime) / 1000);
  }
}

function renderQR(bytes) {
  if (typeof QRCode === "undefined" || typeof QRCode.toCanvas !== "function") {
    throw new Error("Бібліотека QRCode не завантажена (перевірте інтернет-з'єднання).");
  }
  const canvas = $("qrCanvas");
  // qrcode.js: масив чисел (не рядок) із mode:'byte' кодується як «сирі» байти,
  // без UTF-8 перетворення — це критично, бо наші дані бінарні.
  // Колбек qrcode.js асинхронний — тому помилку кодування явно піднімаємо
  // в UI через hint, а не лише в консоль (яка на телефоні недоступна).
  QRCode.toCanvas(
    canvas,
    [{ data: Array.from(bytes), mode: "byte" }],
    { errorCorrectionLevel: "L", margin: 1, scale: 6 },
    (err) => {
      if (err) {
        console.error("QR render error:", err);
        $("sHint").textContent = "⚠ Помилка рендеру QR: " + err.message;
        $("sHint").className = "hint error";
      }
    }
  );
}

// ---------------------------------------------------------------------------
// ОТРИМУВАЧ
// ---------------------------------------------------------------------------

let recvState = null;
let mediaStream = null;
let scanRAF = null;

$("btnStartScan").onclick = startScan;
$("btnStopScan").onclick = stopScan;
$("btnResetRecv").onclick = () => { initReceiverState(); $("rHint").textContent = "Стан скинуто."; $("rHint").className = "hint"; };

function initReceiverState() {
  recvState = {
    sessionId: null,
    decoder: null,
    meta: null,
    startTime: performance.now(),
    scanCount: 0, fpsLastCheck: performance.now(), fpsDisplay: 0,
    newBytesLastCheck: performance.now(), goodputDisplay: 0,
    lastValidFrameAt: 0,
    completed: false,
  };
  $("rProgress").textContent = "0%";
  $("rProgressBar").style.width = "0%";
}
initReceiverState();

async function startScan() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    $("rHint").textContent = "Не вдалося отримати доступ до камери: " + err.message;
    $("rHint").className = "hint error";
    return;
  }
  const video = $("video");
  video.srcObject = mediaStream;
  await video.play();

  if (!recvState || recvState.completed) initReceiverState();

  $("btnStartScan").disabled = true;
  $("btnStopScan").disabled = false;
  $("rHint").textContent = "Сканування… шукаємо QR-кадри.";
  $("rHint").className = "hint";

  scanRAF = requestAnimationFrame(scanLoop);
}

function stopScan() {
  if (scanRAF) cancelAnimationFrame(scanRAF);
  scanRAF = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  $("btnStartScan").disabled = false;
  $("btnStopScan").disabled = true;
  setLock(false);
}

function setLock(on) {
  const badge = $("lockBadge");
  badge.textContent = on ? "СИНХРОНІЗОВАНО" : "НЕМАЄ СИГНАЛУ";
  badge.className = "lock-badge " + (on ? "locked" : "lost");
}

const captureCanvas = $("captureCanvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });

function scanLoop(now) {
  if (!mediaStream) return;
  // Так само, як і в sendLoop: захищаємо тіло циклу від винятків, інакше
  // одна помилка декодування назавжди зупинить сканування без пояснень.
  try {
    scanTick(now);
  } catch (e) {
    console.error("scanLoop error:", e);
    $("rHint").textContent = "⚠ Помилка сканування: " + e.message;
    $("rHint").className = "hint error";
  }
  scanRAF = requestAnimationFrame(scanLoop);
}

function scanTick(now) {
  if (typeof jsQR === "undefined") {
    throw new Error("Бібліотека jsQR не завантажена (перевірте інтернет-з'єднання).");
  }
  const video = $("video");

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    captureCanvas.width = video.videoWidth;
    captureCanvas.height = video.videoHeight;
    captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    const imgData = captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);

    const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "dontInvert" });
    recvState.scanCount++;

    if (code) {
      // jsQR у byte-mode повертає сирі байти в binaryData; якщо його немає
      // (старіша збірка бібліотеки) — відновлюємо байти з кодів символів рядка.
      const bytes = code.binaryData
        ? Uint8Array.from(code.binaryData)
        : Uint8Array.from(Array.from(code.data).map((c) => c.charCodeAt(0) & 0xFF));
      handleFrame(bytes, now);
    }
  }

  // Статистика раз на секунду
  if (now - recvState.fpsLastCheck >= 1000) {
    recvState.fpsDisplay = recvState.scanCount;
    recvState.scanCount = 0;
    recvState.fpsLastCheck = now;

    const decoder = recvState.decoder;
    const newBytes = decoder ? decoder.newBytesSinceTick : 0;
    if (decoder) decoder.newBytesSinceTick = 0;
    recvState.goodputDisplay = (newBytes / 1024).toFixed(1);

    setLock(now - recvState.lastValidFrameAt < 1200);

    $("rFps").textContent = recvState.fpsDisplay;
    $("rGoodput").textContent = recvState.goodputDisplay;
    $("rTimer").textContent = fmtTime((now - recvState.startTime) / 1000);

    if (decoder) {
      const pct = Math.round((decoder.solved / decoder.K) * 100);
      $("rProgress").textContent = pct + "%";
      $("rProgressBar").style.width = pct + "%";
    }
  }
}

function handleFrame(bytes, now) {
  const frame = decodeFrame(bytes);
  if (!frame) return; // не наш кадр / пошкоджений скан — ігноруємо

  const st = recvState;

  // Виявлення нової сесії (сендер почав нову передачу) -> скидаємо стан,
  // якщо поточна сесія ще не завершена успішно.
  if (st.sessionId !== null && st.sessionId !== frame.sessionId && !st.completed) {
    initReceiverState();
  }
  if (st.sessionId === null) st.sessionId = frame.sessionId;
  if (st.sessionId !== frame.sessionId) return; // ігноруємо чужу/стару сесію після завершення

  st.lastValidFrameAt = now;

  if (frame.type === 0) {
    if (!st.meta) {
      st.meta = frame;
      if (!st.decoder) st.decoder = new FountainDecoder(frame.K, frame.blockSize);
    }
  } else if (frame.type === 1) {
    if (!st.decoder) st.decoder = new FountainDecoder(frame.K, frame.blockSize);
    const indices = symbolIndices(frame.sessionId, frame.esi, frame.K);
    st.decoder.addSymbol(frame.esi, indices, frame.payload);
  }

  if (st.decoder && st.decoder.done && st.meta && !st.completed) {
    finishTransfer();
  }
}

function finishTransfer() {
  const st = recvState;
  st.completed = true;
  const fileBytes = st.decoder.assemble(st.meta.fileSize);
  const gotCrc = crc32(fileBytes);

  if (gotCrc !== st.meta.crc) {
    $("rHint").textContent = "Помилка: контрольна сума не збігається. Спробуйте ще раз.";
    $("rHint").className = "hint error";
    st.completed = false; // дозволяємо продовжити прийом додаткових repair-кадрів
    return;
  }

  const blob = new Blob([fileBytes], { type: st.meta.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = st.meta.name || "received_file";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  $("rHint").textContent = `✅ Файл «${st.meta.name}» отримано та збережено!`;
  $("rHint").className = "hint success";
  stopScan();
}
