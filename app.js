"use strict";

const $ = (id) => document.getElementById(id);

let peer = null;
let conn = null;
let myId = null;
let isSender = false;
let selectedFiles = [];
let transferAbort = false;
let scanStream = null;
let scanRAF = null;

// ---------- UI helpers ----------
function show(screen) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screen).classList.add("active");
}

function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), ms);
}

function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " КБ";
  return (b / 1048576).toFixed(2) + " МБ";
}

// ---------- Peer setup ----------
function createPeer(id) {
  return new Promise((resolve, reject) => {
    const p = new Peer(id, {
      debug: 0,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" }
        ]
      }
    });
    p.on("open", (pid) => {
      myId = pid;
      resolve(p);
    });
    p.on("error", (err) => {
      console.error(err);
      reject(err);
    });
  });
}

// ---------- SENDER ----------
$("btnCreate").onclick = async () => {
  show("sender");
  $("sStatus").textContent = "Створення кімнати…";
  $("fileArea").classList.add("hidden");
  $("transferArea").classList.add("hidden");
  selectedFiles = [];
  $("fileList").innerHTML = "";
  $("fileLabel").textContent = "Обрати файли";
  $("btnSend").disabled = true;

  try {
    const shortId = Math.random().toString(36).slice(2, 8).toUpperCase();
    peer = await createPeer(shortId);
    isSender = true;

    $("roomCode").textContent = peer.id;
    $("sStatus").textContent = "Очікуємо підключення…";

    QRCode.toCanvas($("qrCanvas"), peer.id, {
      width: 220,
      margin: 1,
      color: { dark: "#000", light: "#fff" }
    });

    peer.on("connection", (c) => {
      conn = c;
      setupConnection(c);
      $("sStatus").textContent = "Підключено! Оберіть файли";
      $("fileArea").classList.remove("hidden");
      toast("Отримувач підключився");
    });
  } catch (e) {
    $("sStatus").textContent = "Помилка: " + e.message;
    toast("Не вдалося створити кімнату");
  }
};

$("fileInput").onchange = (e) => {
  selectedFiles = Array.from(e.target.files || []);
  const list = $("fileList");
  list.innerHTML = "";
  if (selectedFiles.length === 0) {
    $("fileLabel").textContent = "Обрати файли";
    $("btnSend").disabled = true;
    return;
  }
  $("fileLabel").textContent = `Обрано: ${selectedFiles.length} файл(ів)`;
  selectedFiles.forEach((f) => {
    const li = document.createElement("li");
    li.textContent = `${f.name} (${fmtSize(f.size)})`;
    list.appendChild(li);
  });
  $("btnSend").disabled = false;
};

$("btnSend").onclick = () => {
  if (!conn || selectedFiles.length === 0) return;
  sendFiles(selectedFiles);
};

$("btnCancelSend").onclick = () => {
  transferAbort = true;
  if (conn) conn.send({ type: "abort" });
  $("transferArea").classList.add("hidden");
  $("fileArea").classList.remove("hidden");
  toast("Передачу скасовано");
};

$("btnBackSender").onclick = () => {
  cleanup();
  show("home");
};

// ---------- RECEIVER / JOIN ----------
$("btnJoin").onclick = () => joinRoom($("joinCode").value.trim().toUpperCase());
$("joinCode").onkeydown = (e) => { if (e.key === "Enter") joinRoom($("joinCode").value.trim().toUpperCase()); };

async function joinRoom(code) {
  if (!code) return toast("Введіть код");

  show("receiver");
  $("rStatus").textContent = "Підключення…";
  $("waitArea").classList.remove("hidden");
  $("recvTransfer").classList.add("hidden");
  $("doneArea").classList.add("hidden");
  $("doneList").innerHTML = "";

  try {
    peer = await createPeer();
    isSender = false;

    conn = peer.connect(code, { reliable: true, serialization: "binary" });
    setupConnection(conn);

    conn.on("open", () => {
      $("rStatus").textContent = "Підключено. Чекаємо файли…";
      toast("З’єднано з відправником");
    });
  } catch (e) {
    $("rStatus").textContent = "Помилка: " + e.message;
    toast("Не вдалося підключитися");
  }
}

$("btnBackReceiver").onclick = () => {
  cleanup();
  show("home");
};

// ---------- QR SCANNER ----------
$("btnScanQR").onclick = startScan;
$("btnStopScan").onclick = stopScan;

async function startScan() {
  show("scanner");
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    const video = $("scanVideo");
    video.srcObject = scanStream;
    await video.play();
    scanRAF = requestAnimationFrame(scanLoop);
  } catch (e) {
    toast("Немає доступу до камери: " + e.message);
    show("home");
  }
}

function stopScan() {
  if (scanRAF) cancelAnimationFrame(scanRAF);
  scanRAF = null;
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
  show("home");
}

function scanLoop() {
  if (!scanStream) return;
  const video = $("scanVideo");
  const canvas = $("scanCanvas");
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    if (code && code.data) {
      const val = code.data.trim().toUpperCase();
      if (val.length >= 4) {
        stopScan();
        joinRoom(val);
        return;
      }
    }
  }
  scanRAF = requestAnimationFrame(scanLoop);
}

// ---------- Connection & transfer ----------
function setupConnection(c) {
  try { c.serialization = "binary"; } catch (_) {}

  c.on("data", (data) => {
    if (data.type === "meta") {
      startReceive(data);
    } else if (data.type === "chunk") {
      onChunk(data);
    } else if (data.type === "file-done") {
      onFileDone(data);
    } else if (data.type === "all-done") {
      finishAll();
    } else if (data.type === "abort") {
      toast("Відправник скасував передачу");
      $("recvTransfer").classList.add("hidden");
      $("waitArea").classList.remove("hidden");
      recvState = null;
    }
  });

  c.on("close", () => toast("З’єднання розірвано"));
  c.on("error", (err) => {
    console.error(err);
    toast("Помилка з’єднання");
  });
}

function waitForBuffer(maxBuffered = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    const dc = conn && conn.dataChannel;
    if (!dc || dc.bufferedAmount < maxBuffered) {
      resolve();
      return;
    }
    const check = () => {
      if (!conn || transferAbort || !dc || dc.bufferedAmount < maxBuffered * 0.35) {
        resolve();
      } else {
        setTimeout(check, 15);
      }
    };
    check();
  });
}

async function sendFiles(files) {
  transferAbort = false;
  $("fileArea").classList.add("hidden");
  $("transferArea").classList.remove("hidden");

  const chunkSize = 512 * 1024; // 512 KB

  for (let i = 0; i < files.length && !transferAbort; i++) {
    const file = files[i];
    $("sFileName").textContent = `${file.name} (${i + 1}/${files.length})`;
    $("sFileProgress").textContent = `Файл ${i + 1} з ${files.length}`;

    conn.send({
      type: "meta",
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      index: i,
      total: files.length
    });

    let offset = 0;
    let lastTime = performance.now();
    let lastBytes = 0;

    while (offset < file.size && !transferAbort) {
      await waitForBuffer();

      const end = Math.min(offset + chunkSize, file.size);
      const slice = file.slice(offset, end);
      const buf = await slice.arrayBuffer();

      conn.send({ type: "chunk", data: buf, offset });

      offset += buf.byteLength;

      const pct = Math.min(100, Math.round((offset / file.size) * 100));
      $("sPct").textContent = pct + "%";
      $("sBar").style.width = pct + "%";
      $("sDone").textContent = `${fmtSize(offset)} / ${fmtSize(file.size)}`;

      const now = performance.now();
      if (now - lastTime > 200) {
        const speed = ((offset - lastBytes) / ((now - lastTime) / 1000)) / 1024;
        $("sSpeed").textContent = speed.toFixed(1) + " КБ/с";
        lastTime = now;
        lastBytes = offset;
      }
    }

    if (!transferAbort) {
      conn.send({ type: "file-done", name: file.name, index: i });
    }
  }

  if (!transferAbort) {
    conn.send({ type: "all-done" });
    toast("Усі файли надіслано!");
    $("sStatus").textContent = "Готово ✅";
    $("sPct").textContent = "100%";
    $("sBar").style.width = "100%";
  }
}

// Receiver state
let recvState = null;

function startReceive(meta) {
  if (!recvState) {
    recvState = {
      files: [],
      current: null,
      total: meta.total || 1
    };
  }

  recvState.current = {
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    index: meta.index || 0,
    chunks: [],
    received: 0,
    lastTime: performance.now(),
    lastBytes: 0
  };

  $("waitArea").classList.add("hidden");
  $("recvTransfer").classList.remove("hidden");
  $("doneArea").classList.add("hidden");
  $("rFileName").textContent = `${meta.name} (${(meta.index || 0) + 1}/${meta.total || 1})`;
  $("rPct").textContent = "0%";
  $("rBar").style.width = "0%";
  $("rDone").textContent = `0 / ${fmtSize(meta.size)}`;
  $("rFileProgress").textContent = `Файл ${(meta.index || 0) + 1} з ${meta.total || 1}`;
  $("rStatus").textContent = "Отримання…";
}

function onChunk(msg) {
  if (!recvState || !recvState.current) return;
  const cur = recvState.current;
  cur.chunks.push(new Uint8Array(msg.data));
  cur.received += msg.data.byteLength;

  const pct = Math.min(100, Math.round((cur.received / cur.size) * 100));
  $("rPct").textContent = pct + "%";
  $("rBar").style.width = pct + "%";
  $("rDone").textContent = `${fmtSize(cur.received)} / ${fmtSize(cur.size)}`;

  const now = performance.now();
  if (now - cur.lastTime > 200) {
    const speed = ((cur.received - cur.lastBytes) / ((now - cur.lastTime) / 1000)) / 1024;
    $("rSpeed").textContent = speed.toFixed(1) + " КБ/с";
    cur.lastTime = now;
    cur.lastBytes = cur.received;
  }
}

function onFileDone(data) {
  if (!recvState || !recvState.current) return;
  const cur = recvState.current;
  const blob = new Blob(cur.chunks, { type: cur.mime });
  const url = URL.createObjectURL(blob);
  recvState.files.push({ name: cur.name, url, size: cur.size });
  recvState.current = null;
}

function finishAll() {
  if (!recvState) return;
  $("recvTransfer").classList.add("hidden");
  $("doneArea").classList.remove("hidden");
  $("rStatus").textContent = "Готово ✅";

  const list = $("doneList");
  list.innerHTML = "";
  recvState.files.forEach((f) => {
    const a = document.createElement("a");
    a.href = f.url;
    a.download = f.name;
    a.textContent = `📥 ${f.name} (${fmtSize(f.size)})`;
    list.appendChild(a);
  });
  toast("Усі файли отримано!");
}

function cleanup() {
  stopScan();
  if (conn) { try { conn.close(); } catch (_) {} conn = null; }
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  selectedFiles = [];
  transferAbort = false;
  recvState = null;
}

show("home");
