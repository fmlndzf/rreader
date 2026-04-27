// =========================
// VARIABLES GLOBALES
// =========================
let chunks = [];
let index = 0;

let chapters = [];
let currentChapterIndex = 0;

let isAuto = false;

let minWPM = 100;
let maxWPM = 300; // velocidad actual inicial
let maxWPMCap = 600; // 🔥 límite real superior
let wpmStep = 25;

let rafId = null;
let lastTime = 0;
let accumulator = 0;

let holdDelay = 1000;
let accelerationDuration = 1500;

let pressStartTime = 0;
let pressTimer = null;
let activePointer = false;
let inputLocked = false;

let book;
let currentBookName = null;

let db;

// =========================
// INDEXED DB
// =========================
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("RSVPReaderDB", 1);

    request.onupgradeneeded = e => {
      db = e.target.result;
      db.createObjectStore("books");
    };

    request.onsuccess = e => {
      db = e.target.result;
      resolve();
    };

    request.onerror = reject;
  });
}

function saveBook(file) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("books", "readwrite");
    const store = tx.objectStore("books");
    store.put(file, "currentBook");
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

function loadSavedBook() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("books", "readonly");
    const store = tx.objectStore("books");
    const request = store.get("currentBook");
    request.onsuccess = () => resolve(request.result);
    request.onerror = reject;
  });
}

// =========================
// INIT
// =========================
document.addEventListener("DOMContentLoaded", async () => {

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js");
  }

  await openDB();

  const input = document.getElementById("fileInput");

  document.getElementById("openBook").onclick = () => input.click();

  // 🔥 bloquear HUD
  const hud = document.getElementById("hud");
  ["pointerdown", "pointerup", "click"].forEach(evt => {
    hud.addEventListener(evt, e => e.stopPropagation());
  });

  const savedBook = await loadSavedBook();
  if (savedBook) await loadBook(savedBook);

  input.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    await saveBook(file);
    await loadBook(file);
  });

  updateSpeedDisplay();
});

// =========================
// LOAD BOOK
// =========================
async function loadBook(file) {

  currentBookName = file.name;

  chunks = [];
  chapters = [];
  index = 0;

  stopAuto();
  lastTime = 0;
  accumulator = 0;

  document.getElementById("coverContainer").innerHTML = "";

  book = ePub(file);
  await book.ready;

  updateBookTitleFromMetadata(file.name, book.package.metadata);

  await loadCover();
  await loadSpine();

  index = 0;
  render();

  loadProgress();
}

// =========================
// COVER
// =========================
async function loadCover() {
  try {
    let coverUrl = await book.coverUrl();
    if (coverUrl) chunks.push({ type: "cover", src: coverUrl });
  } catch (e) {}
}

// =========================
// SPINE
// =========================
async function loadSpine() {

  let spineItems = book.spine.spineItems;
  let chapterIndex = 1;

  for (let item of spineItems) {

    if (chunks.length > 0) {
      chunks.push({ type: "chapterBreak" });
    }

    chapters.push({
      name: "Capítulo " + chapterIndex,
      index: chunks.length
    });

    chapterIndex++;

    let doc = await item.load(book.load.bind(book));
    let body = doc.querySelector("body");
    if (!body) continue;

    doc.querySelectorAll("title").forEach(t => t.remove());

    let walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
    let node;

    while (node = walker.nextNode()) {
      let text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (!text) continue;

      chunks.push(...splitWords(text));
    }

    chunks.push("\n\n");
    item.unload();
  }

  buildChapterDropdown();
}

// =========================
// DROPDOWN
// =========================
function buildChapterDropdown() {
  const list = document.getElementById("chapterList");
  const selected = document.getElementById("chapterSelected");

  list.innerHTML = "";

  chapters.forEach((chap, i) => {
    const item = document.createElement("div");
    item.className = "chapterItem";
    item.textContent = chap.name;

    item.onclick = () => {
      index = chap.index;
      currentChapterIndex = i;

      render();
      saveProgress();

      selected.textContent = chap.name;
      list.style.display = "none";
    };

    list.appendChild(item);
  });

  if (chapters.length > 0) {
    selected.textContent = chapters[0].name;
  }
}

function scrollToActiveChapter() {

  const activeItem = document.querySelector(".chapterItem.active");
  const list = document.getElementById("chapterList");

  if (!activeItem || !list) return;

  const itemTop = activeItem.offsetTop;
  const itemHeight = activeItem.offsetHeight;
  const listHeight = list.clientHeight;

  list.scrollTop = itemTop - (listHeight / 2) + (itemHeight / 2);
}
// =========================
// RENDER
// =========================
function render() {

  let container = document.getElementById("textContainer");
  let cover = document.getElementById("coverContainer");

  let leftEl = document.getElementById("left");
  let centerEl = document.getElementById("center");
  let rightEl = document.getElementById("right");

  let current = chunks[index];

  if (typeof current === "object" && current.type === "cover") {
    container.style.display = "none";
    cover.style.display = "flex";
    cover.innerHTML = `<img src="${current.src}" />`;

    updateProgress();
    updateSpeedDisplay();
    updateCurrentChapter();
    return;
  }

  cover.style.display = "none";
  container.style.display = "block";

  if (
    (typeof current === "object" && current.type === "chapterBreak") ||
    current === "\n\n"
  ) {
    const emptyChar = "\u200B";

    leftEl.textContent = emptyChar;
    centerEl.textContent = emptyChar;
    rightEl.textContent = emptyChar;

    updateProgress();
    updateSpeedDisplay();
    updateCurrentChapter();
    return;
  }

  let parts = splitORP(current);

  leftEl.textContent = parts.left;
  centerEl.textContent = parts.center;
  rightEl.textContent = parts.right;

  updateProgress();
  updateSpeedDisplay();
  updateCurrentChapter();
}

// =========================
// HUD
// =========================
function updateProgress() {
  if (!chunks.length) return;
  let percent = Math.floor((index / chunks.length) * 100);
  document.getElementById("progressText").textContent = percent + "%";
}

function updateSpeedDisplay() {
  document.getElementById("speedDisplay").textContent = Math.round(maxWPM) + "wpm";
  updateSpeedButtons(); // 🔥 nuevo
}

function updateCurrentChapter() {
  const selected = document.getElementById("chapterSelected");
  const items = document.querySelectorAll(".chapterItem");

  let current = 0;

  for (let i = 0; i < chapters.length; i++) {
    if (index >= chapters[i].index) current = i;
    else break;
  }

  currentChapterIndex = current;

  if (chapters[current]) {
    selected.textContent = chapters[current].name;
  }

  items.forEach((el, i) => {
    el.classList.toggle("active", i === current);
  });
}

// =========================
// UTIL
// =========================
function splitWords(text) {
  return text.match(/[\p{L}\p{N}]+[.,;:!?]?/gu) || [];
}

function splitORP(word) {
  let len = word.length;
  let pivot = len <= 1 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : len <= 13 ? 3 : 4;

  return {
    left: word.slice(0, pivot),
    center: word[pivot] || "",
    right: word.slice(pivot + 1)
  };
}

// =========================
// TITLE
// =========================
function updateBookTitleFromMetadata(fileName, metadata) {
  document.getElementById("bookTitle").textContent =
    metadata?.title || fileName.replace(/\.epub$/i, "");
}

// =========================
// NAV
// =========================
function next() {
  if (index < chunks.length - 1) {
    index++;
    render();
    saveProgress();
  }
}

function prev() {
  if (index > 0) {
    index--;
    render();
    saveProgress();
  }
}

function startAuto() {
  if (rafId) cancelAnimationFrame(rafId);

  isAuto = true;
  currentWPM = 100;

  let startTime = performance.now();
  lastTime = startTime;
  accumulator = 0;

  function loop(now) {
    if (!isAuto) return;

    let delta = now - lastTime;
    lastTime = now;

    let elapsed = now - startTime;

    currentWPM = elapsed < accelerationDuration
      ? 100 + (elapsed / accelerationDuration) * (maxWPM - 100)
      : maxWPM;

    let delay = calculateDelay();
    accumulator += delta;

    while (accumulator >= delay) {
      next();
      accumulator -= delay;
    }

    rafId = requestAnimationFrame(loop);
  }

  rafId = requestAnimationFrame(loop);
}

function calculateDelay() {
  let base = 60000 / currentWPM;
  let word = chunks[index - 1] || "";

  // pausa de capítulo
  if (typeof word === "object" && word.type === "chapterBreak") {
    return base * 4.5;
  }

  // salto de párrafo
  if (word === "\n\n") return base * 1.8;

  if (typeof word !== "string") return base;

  let len = word.length;

  if (len >= 7) {
    let extraFactor = 1 + Math.min((len - 6) * 0.05, 0.4);
    return base * extraFactor;
  }

  return base;
}

// =========================
// AUTOPLAY
// =========================
function stopAuto() {
  isAuto = false;
  cancelAnimationFrame(rafId);
}

// =========================
// GESTURES
// =========================
document.addEventListener("pointerdown", e => {

  if (e.target.closest("#hud")) return;

  const activeZoneStart = window.innerHeight / 3;
  if (e.clientY < activeZoneStart) return;

  if (activePointer) return;
  activePointer = true;

  if (pressTimer) clearTimeout(pressTimer);

  if (isAuto) {
    stopAuto();
    return;
  }

  pressStartTime = Date.now();

  pressTimer = setTimeout(startAuto, holdDelay);
});

document.addEventListener("pointerup", e => {

  if (e.target.closest("#hud")) return;

  const activeZoneStart = window.innerHeight / 3;
  if (e.clientY < activeZoneStart) return;

  if (!activePointer) return;
  activePointer = false;

  if (inputLocked) return;
  inputLocked = true;
  setTimeout(() => inputLocked = false, 50);

  if (pressTimer) clearTimeout(pressTimer);

  const tapDuration = Date.now() - pressStartTime;

  if (!isAuto && tapDuration < holdDelay) {
    e.clientX < window.innerWidth / 2 ? prev() : next();
    return;
  }

  if (isAuto) stopAuto();
});

// =========================
// PROGRESS SAVE
// =========================
function saveProgress() {
  if (!currentBookName) return;

  localStorage.setItem("rsvp_" + currentBookName, JSON.stringify({
    index,
    maxWPM
  }));
}

function loadProgress() {
  if (!currentBookName) return;

  const saved = localStorage.getItem("rsvp_" + currentBookName);
  if (!saved) return;

  try {
    const data = JSON.parse(saved);

    index = data.index || 0;

    // 🔥 CLAMP DE SEGURIDAD
    maxWPM = Math.min(
      Math.max(data.maxWPM || 300, minWPM),
      maxWPMCap
    );

  } catch (e) {
    console.warn("Error loading progress", e);
  }
}

// =========================
// SPEED BUTTONS
// =========================
document.getElementById("increaseSpeed").addEventListener("click", () => {

  maxWPM = Math.min(maxWPM + wpmStep, maxWPMCap);

  updateSpeedDisplay();
  saveProgress();
});

document.getElementById("decreaseSpeed").addEventListener("click", () => {

  maxWPM = Math.max(maxWPM - wpmStep, minWPM);

  updateSpeedDisplay();
  saveProgress();
});

function updateSpeedButtons() {

  const inc = document.getElementById("increaseSpeed");
  const dec = document.getElementById("decreaseSpeed");

  inc.disabled = maxWPM >= maxWPMCap;
  dec.disabled = maxWPM <= minWPM;
}
// =========================
// CHAPTERLIST
// =========================
const chapterSelected = document.getElementById("chapterSelected");
const chapterList = document.getElementById("chapterList");

chapterSelected.addEventListener("click", (e) => {

  const isOpen = chapterList.style.display === "flex";

  chapterList.style.display = isOpen ? "none" : "flex";

  // scroll automático al abrir
  if (!isOpen) {
    setTimeout(scrollToActiveChapter, 0);
  }

  e.stopPropagation();
});

document.addEventListener("click", (e) => {

  if (!e.target.closest("#chapterDropdown")) {
    chapterList.style.display = "none";
  }

});

document.getElementById("chapterDropdown").addEventListener("pointerdown", e => {
  e.stopPropagation();
});

// =========================
// BLOCK SELECTION
// =========================
document.addEventListener("selectstart", e => e.preventDefault());
document.addEventListener("dblclick", e => e.preventDefault());