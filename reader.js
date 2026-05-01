// =========================
// VARIABLES GLOBALES
// =========================
let chunks = [];
let index = 0;

let chapters = [];
let currentChapterIndex = 0;
let forceChapterPause = false;
let chapterStartTime = null;
let tocMap = {};
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
let autoDirection = 1; // 1 = forward, -1 = backward
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
  
  window.addEventListener("resize", () => {

  const titleEl = document.getElementById("chapterTitleDisplay");

  if (titleEl && titleEl.style.display === "block") {

    setTimeout(() => {
      requestAnimationFrame(() => {
        alignChapterTitleToORP();
      });
    }, 50); // 🔥 pequeño delay

  }
});

window.addEventListener("orientationchange", () => {
  setTimeout(() => alignChapterTitleToORP(), 100);
});

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
  
  const toc = await book.loaded.navigation;

  updateBookTitleFromMetadata(file.name, book.package.metadata);

  await loadCover();
  await loadSpine();
  
  const navigation = await book.loaded.navigation;
buildChaptersFromTOC(navigation);

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

    const href = item.href;
	let chapterName = await extractChapterName(item, chapterIndex);

	// 🔥 guardar posición actual del chunk
	tocMap[href] = chunks.length;
	
	// 🔥 marcador de capítulo
    chunks.push({
  type: "chapterBreak",
  title: chapterName
});

    chapterIndex++;
	
    // 🔥 cargar contenido
    let doc = await item.load(book.load.bind(book));
    let body = doc.querySelector("body");
    if (!body) continue;

    doc.querySelectorAll("title").forEach(t => t.remove());

    let walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
    let node;

    let pendingLetter = "";

while (node = walker.nextNode()) {
  let text = node.nodeValue.replace(/\s+/g, " ").trim();
  if (!text) continue;

  // 🔥 detectar letra suelta (drop cap)
  if (text.length === 1 && /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]$/.test(text)) {
    pendingLetter = text;
    continue;
  }

  // 🔥 si hay letra pendiente, unirla
  if (pendingLetter) {
    text = pendingLetter + text;
    pendingLetter = "";
  }

  let words = splitWords(text);
  chunks.push(...words);
}

    chunks.push("\n\n");

    item.unload();
  }

  buildChapterDropdown();
}

async function extractChapterName(item, fallbackIndex) {
  try {
    const doc = await item.load(book.load.bind(book));

    // 🔥 prioridad 1: h1
    let h1 = doc.querySelector("h1");
    if (h1 && h1.textContent.trim()) {
      return h1.textContent.trim();
    }

    // 🔥 prioridad 2: h2
    let h2 = doc.querySelector("h2");
    if (h2 && h2.textContent.trim()) {
      return h2.textContent.trim();
    }

    // 🔥 prioridad 3: title
    let title = doc.querySelector("title");
    if (title && title.textContent.trim()) {
      return title.textContent.trim();
    }

  } catch (e) {
    console.warn("Error extracting chapter name", e);
  }

  // fallback
  return "Capítulo " + fallbackIndex;
}


function buildChaptersFromTOC(toc) {

  chapters = [];

  function traverse(items) {
    items.forEach(item => {

      // limpiar href (#fragmentos)
      let href = item.href.split("#")[0];

      if (tocMap[href] !== undefined) {
        chapters.push({
          name: item.label.trim(),
          index: tocMap[href]
        });
      }

      // 🔥 subniveles (recursivo)
      if (item.subitems && item.subitems.length > 0) {
        traverse(item.subitems);
      }

    });
  }

  traverse(toc.toc);

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
      
      currentChapterIndex = i;

      index = chap.index;
	  
	  forceChapterPause = true;

// 🔥 forzar pausa simulando transición
accumulator = 0;
lastTime = performance.now();
chapterStartTime = null;//sacar
// 🔥 asegurar que detecte chapterBreak previo
if (index > 0) {
  chunks[index - 1] = { type: "chapterBreak" };
}

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

// 🔥 mostrar portada SIEMPRE que corresponda
if (typeof current === "object" && current.type === "cover") {

  let container = document.getElementById("textContainer");
  let cover = document.getElementById("coverContainer");

  // 🔥 ocultar ORP
  container.style.display = "none";

  // 🔥 mostrar portada
  cover.style.display = "flex";
  cover.innerHTML = `<img src="${current.src}" />`;

  // 🔥 🔥 IMPORTANTE: ocultar título de capítulo
  let titleEl = document.getElementById("chapterTitleDisplay");
  if (titleEl) {
    titleEl.style.display = "none";
  }

  updateProgress();
  updateSpeedDisplay();
  updateCurrentChapter();

  return;
}

  cover.style.display = "none";
  container.style.display = "block";

  if (typeof current === "object" && current.type === "chapterBreak") {

  const container = document.getElementById("textContainer");

  // 🔥 modo título de capítulo
  // ocultar ORP
leftEl.style.visibility = "hidden";
centerEl.style.visibility = "hidden"; // 🔥 importante
rightEl.style.visibility = "hidden";

// 🔥 asegurar que center tenga tamaño
  centerEl.textContent = "•";

// crear o actualizar título
let titleEl = document.getElementById("chapterTitleDisplay");

if (!titleEl) {
  titleEl = document.createElement("div");
  titleEl.id = "chapterTitleDisplay";
  document.getElementById("reader").appendChild(titleEl);
}

titleEl.textContent = current.title || "";
titleEl.style.display = "block";

requestAnimationFrame(() => {
  alignChapterTitleToORP();
}); // 🔥 AQUÍ

  document.getElementById("coverContainer").style.display = "none";
  container.style.display = "block";

  updateProgress();
  updateSpeedDisplay();
  updateCurrentChapter();

  return;
}

// 🔥 RESTAURAR ORP (cuando NO es capítulo ni cover)
leftEl.style.visibility = "visible";
centerEl.style.visibility = "visible";
rightEl.style.visibility = "visible";

// ocultar título si existe
let titleEl = document.getElementById("chapterTitleDisplay");
if (titleEl) titleEl.style.display = "none";

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

	function normalizeText(str) {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function getNextWords(startIndex, count = 6) {
  let words = [];

  for (let i = startIndex; i < chunks.length; i++) {
    if (typeof chunks[i] === "string") {
      words.push(chunks[i]);
      if (words.length >= count) break;
    }
  }

  return words.join(" ");
}

function findPreviousChapterBreak(idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (typeof chunks[i] === "object" && chunks[i].type === "chapterBreak") {
      return chunks[i];
    }
  }
  return null;
}

function alignChapterTitleToORP() {

  const centerEl = document.getElementById("center");
  const titleEl = document.getElementById("chapterTitleDisplay");

  if (!centerEl || !titleEl) return;

  const rect = centerEl.getBoundingClientRect();

  if (rect.width === 0 && rect.height === 0) return; // 🔒 protección extra

  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  titleEl.style.left = x + "px";
  titleEl.style.top = y + "px";
  titleEl.style.transform = "translate(-50%, -25%)";
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
  if (index >= chunks.length - 1) return;

  // 🔥 avanzar índice (saltando saltos de línea)
  do {
    index++;
  } while (
    index < chunks.length &&
    chunks[index] === "\n\n"
  );

  let current = chunks[index];

  // 🔥 evitar duplicado de título
  if (typeof current === "string") {

    let prevChunk = findPreviousChapterBreak(index);

    // 🔒 validación crítica
    if (!prevChunk || !prevChunk.title) {
      render();
      saveProgress();
      return;
    }

    let chapterTitle = normalizeText(prevChunk.title);
    let upcomingText = normalizeText(getNextWords(index, 8));

    // 🔥 comparar inicio del texto con título
    if (chapterTitle && upcomingText.startsWith(chapterTitle)) {

      let wordsToSkip = chapterTitle.split(" ").length;

      for (let i = 0; i < wordsToSkip; i++) {
        if (index < chunks.length - 1) {
          index++;
        }
      }
    }
  }

  render();
  saveProgress();
}

function prev() {
  if (index <= 0) return;

  do {
    index--;
  } while (
    index > 0 &&
    chunks[index] === "\n\n"
  );

  if (typeof chunks[index] === "string") {
  let prevChunk = chunks[index - 1];

  if (prevChunk && prevChunk.type === "chapterBreak") {
    let chapterTitle = normalizeText(prevChunk.title || "");
    let currentWord = normalizeText(chunks[index]);

    if (chapterTitle.startsWith(currentWord)) {
      index--;
    }
  }
}

  render();
  saveProgress();
}

function startAuto() {
  if (rafId) cancelAnimationFrame(rafId);

  isAuto = true;
  currentWPM = 100;

  let startTime = performance.now();
  lastTime = startTime;
  accumulator = 0;

  chapterStartTime = null; // 🔥 reset

  function loop(now) {
    if (!isAuto) return;

    let delta = now - lastTime;
    lastTime = now;

    // 🔥 detectar inicio de capítulo
    if (
      typeof chunks[index] === "object" &&
      chunks[index].type === "chapterBreak"
    ) {
      chapterStartTime = now;
    }

    let elapsed = chapterStartTime
      ? now - chapterStartTime
      : now - startTime;

    currentWPM = elapsed < accelerationDuration
      ? 100 + (elapsed / accelerationDuration) * (maxWPM - 100)
      : maxWPM;

    let delay = calculateDelay();
    accumulator += delta;

    while (accumulator >= delay) {
      if (autoDirection === 1) next();
      else prev();

      accumulator -= delay;
    }

    rafId = requestAnimationFrame(loop);
  }

  rafId = requestAnimationFrame(loop);
}

function calculateDelay() {
  let base = 60000 / currentWPM;
  let current = chunks[index];

  // 🔥 capítulo
  if (typeof current === "object" && current.type === "chapterBreak") {
    return 1000;
  }

  // salto de párrafo
  if (current === "\n\n") return base * 1.8;

  if (typeof current !== "string") return base;

  let len = current.length;

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

  const isRightSide = e.clientX > window.innerWidth / 2;

// definir dirección
autoDirection = isRightSide ? 1 : -1;

// iniciar autoplay según lado
pressTimer = setTimeout(() => {
  startAuto();
}, holdDelay);

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