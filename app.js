"use strict";

const $ = (id) => document.getElementById(id);

let peer = null;
let conn = null;
let myId = null;
let isSender = false;
let currentFile = null;
let transferAbort = false;

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
      debug: 1,
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

  try {
    // короткий читабельний id
    const shortId = Math.random().toString(36).slice(2, 8).toUpperCase();
    peer = await createPeer(shortId);
    isSender = true;

    $("roomCode").textContent = peer.id;
    $("sStatus").textContent = "Очікуємо підключення…";

    // QR з кодом
    QRCode.toCanvas($("qrCanvas"), peer.id, {
      width: 220,
      margin: 1,
      color: { dark: "#000", light: "#fff" }
    });

    peer.on("connection", (c) => {
      conn = c;
      setupConnection(c);
      $("sStatus").textContent = "Підключено! Оберіть файл";
      $("fileArea").classList.remove("hidden");
      toast("Отримувач підключився");
    });
  } catch (e) {
    $("sStatus").textContent = "Помилка: " + e.message;
    toast("Не вдалося створити кімнату");
  }
};

$("fileInput").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  currentFile = f;
  $("fileLabel").textContent = `${f.name} (${fmtSize(f.size)})`;
  $("btnSend").disabled = false;
};

$("btnSend").onclick = () => {
  if (!conn || !currentFile) return;
  sendFile(currentFile);
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

// ---------- RECEIVER ----------
$("btnJoin").onclick = joinRoom;
$("joinCode").onkeydown = (e) => { if (e.key === "Enter") joinRoom(); };

async function joinRoom() {
  const code = $("joinCode").value.trim().toUpperCase();
  if (!code) return toast("Введіть код");

  show("receiver");
  $("rStatus").textContent = "Підключення…";
  $("waitArea").classList.remove("hidden");
  $("recvTransfer").classList.add("hidden");
  $("doneArea").classList.add("hidden");

  try {
    peer = await createPeer(); // random id
    isSender = false;

    conn = peer.connect(code, { reliable: true });
    setupConnection(conn);

    conn.on("open", () => {
      $("rStatus").textContent = "Підключено. Чекаємо файл…";
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

// ---------- Connection & transfer ----------
function setupConnection(c) {
  c.on("data", (data) => {
    if (data.type === "meta") {
      startReceive(data);
    } else if (data.type === "chunk") {
      onChunk(data);
    } else if (data.type === "done") {
      finishReceive();
    } else if (data.type === "abort") {
      toast("Відправник скасував передачу");
      $("recvTransfer").classList.add("hidden");
      $("waitArea").classList.remove("hidden");
    }
  });

  c.on("close", () => {
    toast("З’єднання розірвано");
  });

  c.on("error", (err) => {
    console.error(err);
    toast("Помилка з’єднання");
  });
}

// Sender side
async function sendFile(file) {
  transferAbort = false;
  $("fileArea").classList.add("hidden");
  $("transferArea").classList.remove("hidden");
  $("sFileName").textContent = file.name;
  $("sPct").textContent = "0%";
  $("sBar").style.width = "0%";
  $("sDone").textContent = `0 / ${fmtSize(file.size)}`;

  // meta
  conn.send({
    type: "meta",
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream"
  });

  const chunkSize = 16 * 1024; // 16 KB
  let offset = 0;
  let lastTime = performance.now();
  let lastBytes = 0;

  while (offset < file.size && !transferAbort) {
    const slice = file.slice(offset, offset + chunkSize);
    const buf = await slice.arrayBuffer();
    conn.send({ type: "chunk", data: buf, offset });

    offset += buf.byteLength;
    const pct = Math.round((offset / file.size) * 100);
    $("sPct").textContent = pct + "%";
    $("sBar").style.width = pct + "%";
    $("sDone").textContent = `${fmtSize(offset)} / ${fmtSize(file.size)}`;

    const now = performance.now();
    if (now - lastTime > 500) {
      const speed = ((offset - lastBytes) / ((now - lastTime) / 1000)) / 1024;
      $("sSpeed").textContent = speed.toFixed(1) + " КБ/с";
      lastTime = now;
      lastBytes = offset;
    }

    // backpressure
    await new Promise((r) => setTimeout(r, 0));
  }

  if (!transferAbort) {
    conn.send({ type: "done" });
    toast("Файл надіслано!");
    $("sStatus").textContent = "Готово ✅";
  }
}

// Receiver side
let recvMeta = null;
let recvChunks = [];
let recvReceived = 0;
let recvLastTime = 0;
let recvLastBytes = 0;

function startReceive(meta) {
  recvMeta = meta;
  recvChunks = [];
  recvReceived = 0;
  recvLastTime = performance.now();
  recvLastBytes = 0;

  $("waitArea").classList.add("hidden");
  $("recvTransfer").classList.remove("hidden");
  $("doneArea").classList.add("hidden");
  $("rFileName").textContent = meta.name;
  $("rPct").textContent = "0%";
  $("rBar").style.width = "0%";
  $("rDone").textContent = `0 / ${fmtSize(meta.size)}`;
  $("rStatus").textContent = "Отримання…";
}

function onChunk(msg) {
  if (!recvMeta) return;
  recvChunks.push(new Uint8Array(msg.data));
  recvReceived += msg.data.byteLength;

  const pct = Math.round((recvReceived / recvMeta.size) * 100);
  $("rPct").textContent = pct + "%";
  $("rBar").style.width = pct + "%";
  $("rDone").textContent = `${fmtSize(recvReceived)} / ${fmtSize(recvMeta.size)}`;

  const now = performance.now();
  if (now - recvLastTime > 500) {
    const speed = ((recvReceived - recvLastBytes) / ((now - recvLastTime) / 1000)) / 1024;
    $("rSpeed").textContent = speed.toFixed(1) + " КБ/с";
    recvLastTime = now;
    recvLastBytes = recvReceived;
  }
}

function finishReceive() {
  if (!recvMeta) return;
  const blob = new Blob(recvChunks, { type: recvMeta.mime });
  const url = URL.createObjectURL(blob);

  $("recvTransfer").classList.add("hidden");
  $("doneArea").classList.remove("hidden");
  $("doneName").textContent = recvMeta.name + " (" + fmtSize(recvMeta.size) + ")";
  const a = $("downloadLink");
  a.href = url;
  a.download = recvMeta.name;
  $("rStatus").textContent = "Готово ✅";
  toast("Файл отримано!");
}

function cleanup() {
  if (conn) { try { conn.close(); } catch (_) {} conn = null; }
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  currentFile = null;
  transferAbort = false;
  recvMeta = null;
  recvChunks = [];
}

// start
show("home");
